import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { checkAvailability, createBooking, addBookingPayment, ArtaxError } from "./artaxnet.js";
import { authorize, capture, refund, createPix, getPixTransaction, pixStatusOf, pixData } from "./rede.js";
import { itauTxid, createCob, getCob, cobPaid, cobCanceled } from "./itau.js";
import { ValidationError, validateOneCard } from "./validation.js";
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
const bookStay = async ({
  input,
  rooms,
  reference,
  tid,
  amountCents,
  method = "card",
  releaseAll,
  tids
}) => {
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
  const paymentTids = method === "card" && tids?.length ? tids.join(" + ") : tid;
  const bookingPayload = {
    arrival_date: input.arrival_date,
    departure_date: input.departure_date,
    // Mantido no topo para compatibilidade com o contrato legado do Artax.
    rateplan_id: rooms[0].option.rateplanId,
    status: config.artax.bookingStatus, // 2 = Confirmado (criada só após pagamento)
    comment: [
      input.comment,
      `Acomodações: ${rooms.map((room) => room.option.roomName).join(", ")}`,
      `Pagamento ${paymentLabel} TID ${paymentTids} ref ${reference}`
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

    // CARTÃO: cancela todas as pré-autorizações já feitas. No pagamento
    // dividido, isso libera o limite dos dois cartões se a reserva falhar.
    if (method === "card") {
      let stuck = [];
      if (typeof releaseAll === "function") {
        stuck = await releaseAll();
      } else {
        try {
          await refund(tid, amountCents);
        } catch (refundError) {
          console.error("[checkout] FALHA NO ESTORNO — intervenção manual necessária.", { tid, reference, amountCents });
          stuck = [tid];
        }
      }
      if (!stuck.length) {
        const canceled = new Error("Não foi possível concluir a reserva. O pagamento foi cancelado (você não foi cobrado). Tente novamente.");
        canceled.status = 502;
        canceled.expose = true;
        throw canceled;
      }
      const fatal = new Error(`Pagamento autorizado mas a reserva e o cancelamento falharam. Guarde o comprovante (TID ${stuck.join(", ")}) e contate a pousada.`);
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
const buildArtaxPayment = ({ method, totalPrice, installments = 1, confirmed = true }, index, total) => {
  const payment = {
    payment_method_id: method === "pix" ? config.artax.paymentMethodPix : config.artax.paymentMethodCard,
    gross_amount: Number(Number(totalPrice).toFixed(2)),
    installments: Math.max(1, Number(installments) || 1),
    due_date: new Date().toISOString().slice(0, 10),
    confirmed,
    obs: method === "pix"
      ? "Pagamento via site (PIX)"
      : total > 1
        ? `Pagamento via site (Rede) — cartão ${index + 1} de ${total}`
        : "Pagamento via site (Rede)"
  };
  if (config.artax.costCenterId) payment.cost_center_id = config.artax.costCenterId;
  return payment;
};

// O Artax aceita uma lista de pagamentos. Enviar os dois juntos evita lançar
// apenas metade da divisão caso uma segunda chamada falhasse.
const registerArtaxPayments = async (bookingId, entries) => {
  const payments = entries.map((entry, index) => buildArtaxPayment(entry, index, entries.length));
  try {
    const res = await addBookingPayment(bookingId, payments);
    console.log("[checkout] Pagamento(s) lançado(s) no Artax:", {
      bookingId,
      quantidade: payments.length,
      bills: res.bills?.map((bill) => bill.bill_id)
    });
    return true;
  } catch (err) {
    console.error("[checkout] FALHA ao lançar pagamento no Artax (lançar manualmente).",
      { bookingId, quantidade: payments.length }, err instanceof ArtaxError ? err.payload : err.message);
    return false;
  }
};

const registerArtaxPayment = (bookingId, entry) => registerArtaxPayments(bookingId, [entry]);

// Libera todas as autorizações já feitas e devolve os TIDs que exigem ação
// manual. Enquanto a reserva não existe, nenhuma autorização deve ficar presa.
const releaseAuthorizations = async (auths) => {
  const stuck = [];
  for (const authorization of auths) {
    try {
      await refund(authorization.tid, authorization.amountCents);
    } catch (error) {
      console.error("[checkout] FALHA NO ESTORNO — intervenção manual necessária.", {
        tid: authorization.tid,
        amountCents: authorization.amountCents
      }, error.message);
      stuck.push(authorization.tid);
    }
  }
  return stuck;
};

// Dados de cartão nunca entram na sessão de recuperação. O servidor guarda
// apenas reserva/hóspede e as referências das autorizações da Rede.
const withoutPaymentData = ({ cards, card, installments, ...stay }) => stay;

/* ---------- pagamento dividido com um cartão recusado ----------
   O cartão aprovado fica apenas pré-autorizado enquanto o hóspede substitui o
   recusado. Nada é capturado antes de os dois passarem e a reserva existir. */
const pendingSplits = new Map();
const SPLIT_TTL_MS = 30 * 60 * 1000;

const cleanupSplits = () => {
  const now = Date.now();
  for (const [sessionId, session] of pendingSplits) {
    if (session.retrying || now - session.createdAt <= SPLIT_TTL_MS) continue;
    pendingSplits.delete(sessionId);
    releaseAuthorizations(session.auths).catch(() => {});
    console.warn("[checkout] Sessão dividida expirada — autorizações liberadas.", { sessionId });
  }
};

setInterval(cleanupSplits, 60_000).unref();

const partialPaymentError = ({
  input,
  rooms,
  totalPrice,
  amountCents,
  reference,
  auths,
  failedIndex,
  failedAmountCents,
  reason
}) => {
  cleanupSplits();
  const sessionId = randomUUID();
  pendingSplits.set(sessionId, {
    createdAt: Date.now(),
    retrying: false,
    input,
    rooms,
    totalPrice,
    amountCents,
    reference,
    auths: [...auths],
    failedIndex,
    failedAmountCents
  });

  const error = new Error(`O cartão ${failedIndex + 1} não foi aprovado.`);
  error.status = 402;
  error.expose = true;
  error.partial = {
    sessionId,
    reason,
    failedCard: failedIndex + 1,
    pendingAmount: Number((failedAmountCents / 100).toFixed(2)),
    approved: auths.map((authorization) => ({
      card: authorization.cardIndex,
      amount: Number((authorization.amountCents / 100).toFixed(2)),
      installments: authorization.installments,
      status: "authorized"
    })),
    expiresInMin: Math.round(SPLIT_TTL_MS / 60_000)
  };
  console.warn("[checkout] Pagamento dividido parcial — aguardando troca de cartão.", {
    sessionId,
    failedCard: failedIndex + 1,
    pendingAmount: error.partial.pendingAmount
  });
  return error;
};

/** Substitui o cartão recusado e conclui a mesma tentativa de reserva. */
export const retrySplitCard = async (sessionId, rawCard, maxInstallments) => {
  cleanupSplits();
  const session = pendingSplits.get(sessionId);
  if (!session) {
    const error = new Error("Esta tentativa de pagamento expirou. Refaça a reserva — nenhum valor foi cobrado.");
    error.status = 410;
    error.expose = true;
    throw error;
  }
  if (session.retrying) {
    const error = new Error("Este pagamento já está sendo processado. Aguarde alguns instantes.");
    error.status = 409;
    error.expose = true;
    throw error;
  }

  const card = validateOneCard(rawCard, maxInstallments);
  session.retrying = true;
  let auth;
  try {
    auth = await authorize({
      amountCents: session.failedAmountCents,
      reference: `${session.reference}-r${Date.now().toString(36)}`,
      installments: card.installments,
      card
    });
  } catch (cause) {
    session.retrying = false;
    const error = new Error(`Cartão recusado: ${cause.message}`);
    error.status = cause.status || 402;
    error.expose = true;
    error.partial = {
      sessionId,
      retry: true,
      reason: cause.message,
      failedCard: session.failedIndex + 1,
      pendingAmount: Number((session.failedAmountCents / 100).toFixed(2)),
      approved: session.auths.map((authorization) => ({
        card: authorization.cardIndex,
        amount: Number((authorization.amountCents / 100).toFixed(2)),
        installments: authorization.installments,
        status: "authorized"
      }))
    };
    throw error;
  }

  if (auth.needs3DS) {
    session.retrying = false;
    const error = new Error("Este cartão exige autenticação 3DS, ainda não habilitada nesta versão. Tente outro cartão.");
    error.status = 402;
    error.expose = true;
    error.partial = {
      sessionId,
      retry: true,
      pendingAmount: Number((session.failedAmountCents / 100).toFixed(2))
    };
    throw error;
  }

  pendingSplits.delete(sessionId);
  const auths = [
    ...session.auths,
    {
      cardIndex: session.failedIndex + 1,
      tid: auth.tid,
      amountCents: session.failedAmountCents,
      installments: card.installments,
      auth
    }
  ].sort((a, b) => a.cardIndex - b.cardIndex);

  return finishCardCheckout({
    input: session.input,
    rooms: session.rooms,
    totalPrice: session.totalPrice,
    amountCents: session.amountCents,
    reference: session.reference,
    auths
  });
};

/** Desiste da divisão e libera o limite do cartão que havia sido aprovado. */
export const cancelSplitSession = async (sessionId) => {
  const session = pendingSplits.get(sessionId);
  if (!session) return { released: true, alreadyGone: true };
  if (session.retrying) {
    const error = new Error("O pagamento está sendo processado. Aguarde antes de cancelar.");
    error.status = 409;
    error.expose = true;
    throw error;
  }
  pendingSplits.delete(sessionId);
  const stuck = await releaseAuthorizations(session.auths);
  if (stuck.length) {
    console.error("[checkout] Cancelamento da divisão: estorno falhou.", { sessionId, stuck });
    return { released: false, tids: stuck };
  }
  console.log("[checkout] Sessão dividida cancelada e autorizações liberadas.", { sessionId });
  return { released: true };
};

/* ============ CARTÃO: pré-autoriza → cria reserva → captura ============ */
export const processCheckout = async (input) => {
  const { rooms, totalPrice, amountCents } = await resolveStay(input);
  const reservationInput = withoutPaymentData(input);
  const reference = `VZ-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const cards = input.cards?.length
    ? input.cards
    : [{ ...input.card, installments: input.installments, amountCents: null }];
  const split = cards.length > 1;
  const parts = split ? cards.map((card) => card.amountCents) : [amountCents];

  // A soma usa o preço autoritativo recém-consultado no Artax. A validação
  // ocorre antes de qualquer autorização, portanto erro de divisão não cobra.
  if (split) {
    const minimumCents = Math.round(config.rede.minCardAmount * 100);
    if (parts.some((value) => value < minimumCents)) {
      throw new ValidationError(
        `Cada cartão precisa ter pelo menos R$ ${config.rede.minCardAmount.toFixed(2).replace(".", ",")}. `
        + "Ajuste a divisão ou pague em um cartão só."
      );
    }
    const sum = parts.reduce((total, value) => total + value, 0);
    if (sum !== amountCents) {
      const difference = (Math.abs(sum - amountCents) / 100).toFixed(2).replace(".", ",");
      throw new ValidationError(
        sum > amountCents
          ? `A soma dos dois cartões passa R$ ${difference} do total da reserva.`
          : `Faltam R$ ${difference} para fechar o total da reserva.`
      );
    }
  }

  const auths = [];
  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index];
    const partCents = parts[index];
    let auth;
    try {
      auth = await authorize({
        amountCents: partCents,
        reference: split ? `${reference}-${index + 1}` : reference,
        installments: card.installments,
        card
      });
    } catch (cause) {
      if (auths.length) {
        throw partialPaymentError({
          input: reservationInput,
          rooms,
          totalPrice,
          amountCents,
          reference,
          auths,
          failedIndex: index,
          failedAmountCents: partCents,
          reason: cause.message
        });
      }
      const error = new Error(`Cartão ${index + 1} recusado: ${cause.message} Nenhum valor foi cobrado.`);
      error.status = cause.status || 402;
      error.expose = true;
      throw error;
    }

    if (auth.needs3DS) {
      if (auths.length) {
        throw partialPaymentError({
          input: reservationInput,
          rooms,
          totalPrice,
          amountCents,
          reference,
          auths,
          failedIndex: index,
          failedAmountCents: partCents,
          reason: "Este cartão exige autenticação 3DS, ainda não habilitada nesta versão."
        });
      }
      const error = new Error(`O cartão ${index + 1} exige autenticação 3DS (ainda não habilitada). Use PIX ou outro cartão. Nenhum valor foi cobrado.`);
      error.status = 402;
      error.expose = true;
      throw error;
    }

    auths.push({
      cardIndex: index + 1,
      tid: auth.tid,
      amountCents: partCents,
      installments: card.installments,
      auth
    });
  }

  return finishCardCheckout({
    input: reservationInput,
    rooms,
    totalPrice,
    amountCents,
    reference,
    auths
  });
};

// Conclusão compartilhada pelo checkout inicial e pela troca do cartão
// recusado: reserva uma vez, captura cada cobrança e lança ambas no Artax.
const finishCardCheckout = async ({ input, rooms, totalPrice, amountCents, reference, auths }) => {
  const first = auths[0];
  const booked = await bookStay({
    input,
    rooms,
    reference,
    tid: first.tid,
    amountCents,
    releaseAll: () => releaseAuthorizations(auths),
    tids: auths.map((authorization) => authorization.tid)
  });

  const charges = [];
  for (let index = 0; index < auths.length; index += 1) {
    const authorization = auths[index];
    let captured = true;
    try {
      await capture({ tid: authorization.tid, amountCents: authorization.amountCents });
    } catch (error) {
      captured = false;
      console.error(`[checkout] Reserva criada, mas a CAPTURA do cartão ${index + 1} falhou — capturar manualmente (TID ${authorization.tid}).`, error.message);
    }
    charges.push({
      card: authorization.cardIndex,
      tid: authorization.tid,
      amount: Number((authorization.amountCents / 100).toFixed(2)),
      installments: authorization.installments,
      status: captured ? "captured" : "pending_capture",
      authorizationCode: authorization.auth.authorizationCode
    });
  }

  const captured = charges.every((charge) => charge.status === "captured");
  const paymentRegistered = await registerArtaxPayments(
    booked.booking_id,
    charges.map((charge) => ({
      method: "card",
      totalPrice: charge.amount,
      installments: charge.installments,
      confirmed: charge.status === "captured"
    }))
  );

  // Não exibe "pago" quando alguma captura ainda exige ação manual.
  if (!captured) {
    const pendingCapture = new Error(
      `A reserva nº ${booked.booking_id} foi criada, mas um pagamento ainda precisa de confirmação. Não tente novamente; contate a recepção e informe esse número.`
    );
    pendingCapture.status = 502;
    pendingCapture.expose = true;
    throw pendingCapture;
  }

  const combinedTid = auths.map((authorization) => authorization.tid).join(" + ");
  fireConfirmationEmail({ input, rooms, totalPrice, bookingId: booked.booking_id, method: "card", tid: combinedTid });
  fireAsksuiteNotification({ input, rooms, totalPrice, bookingId: booked.booking_id, method: "card", tid: combinedTid });
  fireAsksuitePurchaseTracking({ input, rooms, totalPrice, bookingId: booked.booking_id });

  return {
    booking_id: booked.booking_id,
    rooms: booked.rooms,
    ...(booked.room ? { room: booked.room } : {}),
    payment: {
      method: "card",
      tid: first.tid,
      authorizationCode: first.auth.authorizationCode,
      reference,
      installments: first.installments,
      amount: totalPrice,
      captured,
      registered: paymentRegistered,
      split: auths.length > 1,
      charges
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
