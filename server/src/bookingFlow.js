import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { checkAvailability, createBooking, addBookingPayment, ArtaxError } from "./artaxnet.js";
import { authorize, capture, refund, createPix, getPixTransaction, pixStatusOf, pixData } from "./rede.js";
import { itauTxid, createCob, getCob, cobPaid, cobCanceled } from "./itau.js";
import { ValidationError } from "./validation.js";
import { sendBookingConfirmation } from "./email.js";
import { notifyAsksuiteBooking, notifyAsksuitePurchase } from "./partners.js";

const nightsBetween = (arrival, departure) =>
  Math.max(1, Math.round((new Date(departure) - new Date(arrival)) / 86_400_000));

/** Dispara o e-mail de confirmação (fire-and-forget; nunca derruba a reserva). */
const fireConfirmationEmail = ({ input, rooms, totalPrice, bookingId, method, tid }) => {
  const to = input?.guest?.email;
  if (!to) return;
  sendBookingConfirmation({
    to,
    guestName: [input.guest.first_name, input.guest.last_name].filter(Boolean).join(" "),
    rooms: rooms.map((room) => ({ name: room.option.roomName, price: room.totalPrice })),
    checkIn: input.arrival_date,
    checkOut: input.departure_date,
    nights: nightsBetween(input.arrival_date, input.departure_date),
    adults: input.adults,
    kids: input.kids,
    totalPrice,
    bookingId,
    method,
    tid
  }).catch((e) => console.error("[email] falha inesperada:", e.message));
};

/** Notifica parceiros sem bloquear o checkout ou expor dados de cartao. */
const fireAsksuiteNotification = ({ input, rooms, totalPrice, bookingId, method, tid }) => {
  const partnerRooms = rooms.map((room) => ({
    id: room.roomId,
    name: room.option.roomName,
    rateplan_id: room.option.rateplanId,
    price: room.totalPrice
  }));

  notifyAsksuiteBooking({
    event: "booking.confirmed",
    property: { code: "VZ", name: "Villa Zanotto Piri" },
    booking_id: bookingId,
    arrival_date: input.arrival_date,
    departure_date: input.departure_date,
    nights: nightsBetween(input.arrival_date, input.departure_date),
    rooms: partnerRooms,
    // Alias legado do webhook enquanto a integracao singular estiver ativa.
    ...(partnerRooms.length === 1 ? { room: partnerRooms[0] } : {}),
    guests: { adults: input.adults, kids: input.kids },
    guest: {
      first_name: input.guest?.first_name,
      last_name: input.guest?.last_name,
      email: input.guest?.email,
      phone: input.guest?.phone
    },
    payment: { method, amount: totalPrice, currency: "BRL", tid },
    confirmed_at: new Date().toISOString()
  }).catch((e) => console.error("[asksuite] falha inesperada:", e.message));
};

/**
 * Notifica a Asksuite da compra vinculada à sessão de atendimento (_askSI),
 * no formato pedido pelo Felippe (17/08/2026, mesma chave pra todos os
 * clientes confirmada em 19/08/2026). Só dispara se a reserva carregar um
 * _askSI (ou seja, veio do link direto que a IA deles gera).
 */
const fireAsksuitePurchaseTracking = ({ input, rooms, totalPrice, bookingId }) => {
  const askSi = input.askSi;
  if (!askSi) return;
  notifyAsksuitePurchase({
    event: "purchase",
    products: rooms.map((room) => ({ currency: "BRL", price: room.totalPrice, quantity: 1 })),
    session: { _askSI: askSi },
    dataLayer: {
      ecommerce: {
        purchase: {
          // `revenue` é o valor total da reserva. Sem ele a Asksuite recebe os
          // preços item a item mas não o total da compra — e o painel de
          // "Reservas realizadas (R$)" fica zerado. O Pixel do front já enviava
          // esse campo; aqui faltava.
          actionField: { id: String(bookingId), revenue: Number(totalPrice || 0).toFixed(2), currency: "BRL" },
          products: rooms.map((room) => ({
            name: room.option.roomName,
            price: room.totalPrice,
            category: "",
            quantity: 1,
            currency: "BRL"
          }))
        }
      }
    }
  }).catch((e) => console.error("[asksuite] falha inesperada (purchase tracking):", e.message));
};

/** Encontra a opção (quarto + rateplan) e devolve o PREÇO AUTORITATIVO do Artax. */
const resolveAuthoritativeOption = (availability, roomId, rateplanId) => {
  const rooms = availability?.rooms;
  if (!rooms || Array.isArray(rooms)) return null; // [] => sem disponibilidade
  const room = rooms[roomId] || rooms[String(roomId)];
  if (!room) return null;
  const option = room[rateplanId] || room[String(rateplanId)];
  if (!option) return null;
  const price = Number(option.price);
  if (!Number.isFinite(price) || price <= 0) return null;
  return {
    roomName: option.room_name,
    rateplanId: Number(option.rateplan_id) || Number(rateplanId),
    price,
    capacity: option.capacity || null,
    allots: option.allots
  };
};

/**
 * Reconfere disponibilidade no momento da compra e calcula o total a cobrar.
 * A consulta e unica e o preco autoritativo de cada acomodacao vem do Artax.
 */
const resolveStay = async (input) => {
  const availability = await checkAvailability({
    arrival_date: input.arrival_date,
    departure_date: input.departure_date,
    adults: input.adults,
    kids: input.kids,
    ages: input.ages
  });
  const nights = nightsBetween(input.arrival_date, input.departure_date);

  let totalPrice = 0;
  const rooms = input.rooms.map(({ roomId, rateplanId }) => {
    const option = resolveAuthoritativeOption(availability, roomId, rateplanId);
    if (!option) {
      throw new ValidationError("Uma das acomodações selecionadas não está mais disponível para estas datas. Refaça a busca.");
    }
    const roomTotal = config.artax.priceMode === "per_night"
      ? Number((option.price * nights).toFixed(2))
      : option.price;
    totalPrice += roomTotal;
    return { roomId, option, totalPrice: roomTotal };
  });

  totalPrice = Number(totalPrice.toFixed(2));
  return { rooms, totalPrice, amountCents: Math.round(totalPrice * 100) };
};

/**
 * Cria a reserva no Artax após o pagamento confirmado. Se a criação falhar,
 * faz a compensação conforme o método:
 *  - cartão: a pré-autorização (capture:false) é cancelada → cliente NÃO é cobrado.
 *  - pix: o valor já foi recebido; não há refund PIX automático aqui, então
 *         alertamos para DEVOLUÇÃO MANUAL e orientamos o cliente a contatar a pousada.
 */
const bookStay = async ({ input, rooms, reference, tid, amountCents, method = "card" }) => {
  const guestEntry = [
    {
      first_name: input.guest.first_name,
      last_name: input.guest.last_name,
      document: input.guest.document,
      document_type: input.guest.document_type,
      phone: input.guest.phone,
      email: input.guest.email
    }
  ];

  const room_units = {};
  for (const room of rooms) {
    room_units[room.roomId] = {
      rateplan_id: room.option.rateplanId,
      price: room.totalPrice,
      adults: input.adults,
      kids: input.kids,
      ages: input.ages,
      guests: guestEntry
    };
  }

  const paymentLabel = method === "pix" ? "PIX" : "Rede";
  const bookingPayload = {
    arrival_date: input.arrival_date,
    departure_date: input.departure_date,
    // Mantido no topo para compatibilidade com o contrato legado do Artax.
    rateplan_id: rooms[0].option.rateplanId,
    status: config.artax.bookingStatus, // 2 = Confirmado (criada só após pagamento)
    comment: [
      input.comment,
      `Acomodações: ${rooms.map((room) => room.option.roomName).join(", ")}`,
      `Pagamento ${paymentLabel} TID ${tid} ref ${reference}`
    ].filter(Boolean).join(" | "),
    guest: input.guest,
    room_units
  };

  try {
    const booking = await createBooking(bookingPayload);
    const bookedRooms = rooms.map((room) => ({
      id: room.roomId,
      name: room.option.roomName,
      rateplan_id: room.option.rateplanId,
      price: room.totalPrice
    }));
    return {
      booking_id: booking.booking_id,
      rooms: bookedRooms,
      // O checkout legado renderiza data.room.name.
      ...(bookedRooms.length === 1 ? { room: bookedRooms[0] } : {})
    };
  } catch (error) {
    console.error("[checkout] Reserva falhou após pagamento.", { method, tid, reference },
      error instanceof ArtaxError ? error.payload : error.message);

    // CARTÃO: cancela a pré-autorização (libera o limite; cliente não é cobrado).
    if (method === "card") {
      let refunded = false;
      try {
        await refund(tid, amountCents);
        refunded = true;
      } catch (refundError) {
        console.error("[checkout] FALHA NO ESTORNO — intervenção manual necessária.", { tid, reference, amountCents });
      }
      if (refunded) {
        const canceled = new Error("Não foi possível concluir a reserva. O pagamento foi cancelado (você não foi cobrado). Tente novamente.");
        canceled.status = 502;
        canceled.expose = true;
        throw canceled;
      }
      const fatal = new Error(`Pagamento autorizado mas a reserva e o cancelamento falharam. Guarde o comprovante (TID ${tid}) e contate a pousada.`);
      fatal.status = 500;
      fatal.expose = true;
      throw fatal;
    }

    // PIX: o valor já foi recebido → exige devolução manual (sem refund automático aqui).
    console.error("[checkout] PIX PAGO mas a reserva falhou — DEVOLUÇÃO MANUAL necessária.", { tid, reference, amountCents });
    const fatal = new Error(`Recebemos seu PIX, mas houve uma falha ao confirmar a reserva. Guarde o comprovante (TID ${tid}) e contate a pousada para regularizar.`);
    fatal.status = 500;
    fatal.expose = true;
    throw fatal;
  }
};

/**
 * Registra o pagamento na reserva do Artax (lança no financeiro).
 * Não derruba a reserva se falhar: a reserva já existe e o dinheiro foi
 * processado na Rede — apenas alerta para lançamento manual.
 */
const registerArtaxPayment = async (bookingId, { method, totalPrice, installments = 1, confirmed = true }) => {
  const payment = {
    payment_method_id: method === "pix" ? config.artax.paymentMethodPix : config.artax.paymentMethodCard,
    gross_amount: Number(Number(totalPrice).toFixed(2)),
    installments: Math.max(1, Number(installments) || 1),
    due_date: new Date().toISOString().slice(0, 10),
    confirmed,
    obs: `Pagamento via site (${method === "pix" ? "PIX" : "Rede"})`
  };
  if (config.artax.costCenterId) payment.cost_center_id = config.artax.costCenterId;

  try {
    const res = await addBookingPayment(bookingId, [payment]);
    console.log("[checkout] Pagamento lançado no Artax:", { bookingId, confirmed, bills: res.bills?.map((b) => b.bill_id) });
    return true;
  } catch (err) {
    console.error("[checkout] FALHA ao lançar pagamento no Artax (lançar manualmente).",
      { bookingId, method, installments }, err instanceof ArtaxError ? err.payload : err.message);
    return false;
  }
};

/* ============ CARTÃO: pré-autoriza → cria reserva → captura ============ */
export const processCheckout = async (input) => {
  const { rooms, totalPrice, amountCents } = await resolveStay(input);
  const reference = `VZ-${Date.now()}-${randomUUID().slice(0, 8)}`;

  // 1) Pré-autorização (NÃO cobra ainda — só reserva o limite).
  const auth = await authorize({ amountCents, reference, installments: input.installments, card: input.card });
  if (auth.needs3DS) {
    const e = new Error("Este cartão exige autenticação 3DS (ainda não habilitada nesta versão). Use PIX ou outro cartão.");
    e.status = 402;
    throw e;
  }

  // 2) Cria a reserva no Artax (se falhar, bookStay cancela a pré-autorização → cliente não é cobrado).
  const booked = await bookStay({ input, rooms, reference, tid: auth.tid, amountCents });

  // 3) Reserva garantida → captura (só agora cobra de fato).
  let captured = true;
  try {
    await capture({ tid: auth.tid, amountCents });
  } catch (capErr) {
    captured = false;
    console.error("[checkout] Reserva criada, mas a CAPTURA falhou — capturar manualmente (TID " + auth.tid + ").", capErr.message);
  }

  // 4) Lança o pagamento na reserva do Artax (confirmado apenas se capturado).
  const paymentRegistered = await registerArtaxPayment(booked.booking_id, {
    method: "card",
    totalPrice,
    installments: input.installments,
    confirmed: captured
  });

  // Nunca sinaliza sucesso ao navegador quando a reserva existe, mas a
  // captura ainda exige intervenção. Isso evita exibir "Pago" indevidamente
  // e orienta o hóspede a não repetir a compra.
  if (!captured) {
    const pendingCapture = new Error(
      `A reserva nº ${booked.booking_id} foi criada, mas o pagamento ainda precisa de confirmação. Não tente novamente; contate a recepção e informe esse número.`
    );
    pendingCapture.status = 502;
    pendingCapture.expose = true;
    throw pendingCapture;
  }

  // E-mail de confirmação — SÓ após o pagamento (cartão efetivamente capturado).
  // Não bloqueia a resposta ao cliente.
  if (captured) {
    fireConfirmationEmail({ input, rooms, totalPrice, bookingId: booked.booking_id, method: "card", tid: auth.tid });
    fireAsksuiteNotification({ input, rooms, totalPrice, bookingId: booked.booking_id, method: "card", tid: auth.tid });
    fireAsksuitePurchaseTracking({ input, rooms, totalPrice, bookingId: booked.booking_id });
  }

  return {
    booking_id: booked.booking_id,
    rooms: booked.rooms,
    ...(booked.room ? { room: booked.room } : {}),
    payment: {
      method: "card",
      tid: auth.tid,
      authorizationCode: auth.authorizationCode,
      reference,
      installments: input.installments,
      amount: totalPrice,
      captured,
      registered: paymentRegistered
    }
  };
};

/* ===================== PIX (gera QR; reserva só após pago) ===================== */
// Guarda o contexto da cobrança PIX até o pagamento ser confirmado.
// (Single instance no Railway; o PIX expira em minutos, então memória basta.)
const pendingPix = new Map();
const PIX_TTL_MS = 60 * 60 * 1000;
const PIX_EXPIRES_MIN = Number(process.env.PIX_EXPIRES_MIN) || 15; // validade do QR Code (min)

const cleanupPix = () => {
  const now = Date.now();
  for (const [tid, e] of pendingPix) if (now - e.createdAt > PIX_TTL_MS) pendingPix.delete(tid);
};

// A Rede exige reference de até 16 caracteres alfanuméricos para o PIX.
const pixReference = () =>
  ("VZ" + Date.now().toString(36) + randomUUID().replace(/-/g, ""))
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 16);

export const createPixCharge = async (input) => {
  cleanupPix();
  const { rooms, totalPrice, amountCents } = await resolveStay(input);
  const reference = pixReference();

  let tid, qrCode, qrImage = "", expiresInSec;
  if (config.pixProvider === "itau") {
    tid = itauTxid();
    const cob = await createCob({ txid: tid, amountCents, solicitacaoPagador: "Reserva Villa Zanotto Piri" });
    qrCode = cob.pixCopiaECola;
    expiresInSec = config.itau.expiracao;
  } else {
    const expiresAt = new Date(Date.now() + PIX_EXPIRES_MIN * 60_000);
    const pix = await createPix({ amountCents, reference, expiresAt });
    if (!pix.tid) throw new Error("A Rede não retornou o identificador da cobrança PIX.");
    tid = pix.tid;
    qrCode = pix.qrCode;
    qrImage = pix.qrImage;
    expiresInSec = PIX_EXPIRES_MIN * 60;
  }
  console.log("[pix] criado", { provider: config.pixProvider, tid, reference, amountCents });

  pendingPix.set(tid, {
    provider: config.pixProvider,
    input,
    rooms,
    totalPrice,
    amountCents,
    reference,
    bookingId: null,
    bookedRooms: null,
    room: null,
    createdAt: Date.now()
  });

  return {
    tid,
    qrCode, // copia-e-cola (EMV)
    qrImage, // imagem do QR em base64 (PNG) — Itaú não envia; front gera do copia-e-cola
    amount: totalPrice,
    expiresInSec
  };
};

const paidPixResult = (entry, tid) => ({
  status: "paid",
  booking_id: entry.bookingId,
  rooms: entry.bookedRooms,
  ...(entry.room ? { room: entry.room } : {}),
  payment: { method: "pix", tid, reference: entry.reference, amount: entry.totalPrice, registered: entry.registered }
});

export const confirmPix = async (tid) => {
  const entry = pendingPix.get(tid);
  if (!entry) return { status: "expired" };

  // Já reservado? Devolve o mesmo resultado (idempotente).
  if (entry.bookingId) return paidPixResult(entry, tid);

  // Determina o status conforme o provedor (o tid já amarra à nossa cobrança).
  let paid = false;
  let canceled = false;
  if (entry.provider === "itau") {
    const cob = await getCob(tid);
    paid = cobPaid(cob);
    canceled = cobCanceled(cob);
  } else {
    const tx = await getPixTransaction(tid);
    const norm = pixStatusOf(tx).toLowerCase();
    console.log("[pix] consulta(rede)", { tid, status: norm });
    canceled = ["canceled", "cancelled", "denied", "declined"].includes(norm);
    paid = ["approv", "aprov", "conclu", "paid", "pago", "confirm", "captur", "settl"].some((s) => norm.includes(s));
  }
  if (canceled) return { status: "canceled" };
  if (!paid) return { status: "pending" }; // não pago -> NÃO cria reserva

  // IDEMPOTÊNCIA: cria a reserva UMA única vez por cobrança, mesmo com polling
  // e webhook chegando juntos. O teste+atribuição do promise é síncrono (sem
  // await no meio), então chamadas concorrentes reaproveitam o mesmo promise.
  if (!entry.bookingPromise) {
    entry.bookingPromise = (async () => {
      const booked = await bookStay({
        input: entry.input,
        rooms: entry.rooms,
        reference: entry.reference,
        tid,
        amountCents: entry.amountCents,
        method: "pix"
      });
      entry.bookingId = booked.booking_id;
      entry.bookedRooms = booked.rooms;
      entry.room = booked.room;
      entry.registered = await registerArtaxPayment(booked.booking_id, {
        method: "pix",
        totalPrice: entry.totalPrice,
        installments: 1,
        confirmed: true
      });
      // E-mail de confirmação — dentro do bookingPromise (roda uma vez por cobrança).
      fireConfirmationEmail({ input: entry.input, rooms: entry.rooms, totalPrice: entry.totalPrice, bookingId: booked.booking_id, method: "pix", tid });
      fireAsksuiteNotification({ input: entry.input, rooms: entry.rooms, totalPrice: entry.totalPrice, bookingId: booked.booking_id, method: "pix", tid });
      fireAsksuitePurchaseTracking({ input: entry.input, rooms: entry.rooms, totalPrice: entry.totalPrice, bookingId: booked.booking_id });
      return booked;
    })().catch((err) => {
      entry.bookingPromise = null; // libera p/ nova tentativa se falhou
      throw err;
    });
  }

  await entry.bookingPromise;
  return paidPixResult(entry, tid);
};

/**
 * Reconciliação: varre os PIX pendentes e confirma os que já foram pagos —
 * cobre o caso "cliente pagou e fechou a página" SEM depender do webhook.
 * Roda periodicamente no servidor (ver server.js). É idempotente (usa confirmPix).
 */
export const reconcilePendingPix = async () => {
  cleanupPix();
  for (const [tid, entry] of pendingPix) {
    if (entry.bookingId || entry.bookingPromise) continue; // já reservado / em andamento
    try {
      const res = await confirmPix(tid);
      if (res.status === "paid") {
        console.log("[pix] reconciliado -> reserva", res.booking_id, "tid", tid);
      }
    } catch (err) {
      console.warn("[pix] reconciliação falhou", { tid, msg: err.message });
    }
  }
};
