const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.status = 422;
  }
}

const isValidDate = (value) => {
  if (!DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
};

const toDateOnly = (value) => new Date(`${value}T00:00:00Z`);

const todayInPropertyTimezone = () => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const onlyDigits = (value) => String(value || "").replace(/\D/g, "");

/** Valida os parâmetros de uma consulta de disponibilidade. */
export const validateAvailability = (q) => {
  const arrival_date = String(q.arrival_date || "");
  const departure_date = String(q.departure_date || "");
  const adults = Number(q.adults);
  const kids = Number(q.kids ?? 0);
  const ages = Array.isArray(q.ages) ? q.ages.map(Number) : [];

  if (!isValidDate(arrival_date) || !isValidDate(departure_date)) {
    throw new ValidationError("Datas inválidas. Use o formato YYYY-MM-DD.");
  }
  if (arrival_date < todayInPropertyTimezone()) {
    throw new ValidationError("A data de check-in não pode estar no passado.");
  }
  if (toDateOnly(departure_date) <= toDateOnly(arrival_date)) {
    throw new ValidationError("A data de check-out deve ser maior que a de check-in.");
  }
  if (!Number.isInteger(adults) || adults < 1) {
    throw new ValidationError("Informe ao menos 1 adulto.");
  }
  if (!Number.isInteger(kids) || kids < 0) {
    throw new ValidationError("Número de crianças inválido.");
  }
  if (kids > 0 && ages.length !== kids) {
    throw new ValidationError("Informe a idade de cada criança.");
  }
  if (ages.some((age) => !Number.isInteger(age) || age < 0 || age > 17)) {
    throw new ValidationError("Idades de crianças inválidas.");
  }

  return { arrival_date, departure_date, adults, kids, ages };
};

/** Valida a reserva + hóspede (comum a cartão e PIX, sem dados de pagamento). */
export const validateStayGuest = (body) => {
  const base = validateAvailability(body);

  // Contrato atual: rooms[]. Contrato legado: room_id/rateplan_id. Os dois
  // permanecem aceitos para permitir deploy independente do site e da API.
  const rawRooms = Array.isArray(body.rooms) && body.rooms.length
    ? body.rooms
    : (body.room_id ? [{ room_id: body.room_id, rateplan_id: body.rateplan_id }] : []);
  if (!rawRooms.length) throw new ValidationError("Selecione ao menos uma acomodação.");

  const seenRoomIds = new Set();
  const rooms = rawRooms.map((room) => {
    const roomId = String(room?.room_id || "").trim();
    const rateplanId = Number(room?.rateplan_id);
    if (!roomId) throw new ValidationError("Categoria de quarto não informada.");
    if (!Number.isInteger(rateplanId) || rateplanId <= 0) {
      throw new ValidationError("Plano tarifário inválido.");
    }
    if (seenRoomIds.has(roomId)) {
      throw new ValidationError("Cada acomodação só pode ser selecionada uma vez.");
    }
    seenRoomIds.add(roomId);
    return { roomId, rateplanId };
  });

  const guest = body.guest || {};
  const firstName = String(guest.first_name || "").trim();
  const phone = onlyDigits(guest.phone);
  if (!firstName) throw new ValidationError("Nome do hóspede é obrigatório.");
  if (phone.length < 10) throw new ValidationError("Telefone do hóspede é obrigatório e deve ser válido.");
  const guestType = guest.type === "company" ? "company" : "guest";
  const documentType = ["cpf", "rg", "passport"].includes(guest.document_type) ? guest.document_type : undefined;
  const rawDocument = String(guest.document || "").trim();
  const document = documentType === "passport"
    ? rawDocument.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20)
    : onlyDigits(rawDocument);
  if (guest.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(guest.email)) {
    throw new ValidationError("E-mail do hóspede inválido.");
  }

  // Identificador de sessão da Asksuite (_askSI), quando a reserva veio do
  // link direto que a IA deles gera — usado pra vincular a compra ao
  // atendimento no rastreio de conversão deles.
  const askSi = String(body.ask_si || "").trim().slice(0, 200) || undefined;

  return {
    ...base,
    rooms,
    // Aliases internos legados: consumidores que importavam o validador
    // continuam funcionando no fluxo de uma unica acomodacao.
    ...(rooms.length === 1 ? { roomId: rooms[0].roomId, rateplanId: rooms[0].rateplanId } : {}),
    askSi,
    comment: String(body.comment || "").slice(0, 500),
    guest: {
      first_name: firstName,
      last_name: String(guest.last_name || "").trim() || undefined,
      document: document || undefined,
      document_type: documentType,
      phone,
      email: String(guest.email || "").trim() || undefined,
      type: guestType
    }
  };
};

/** Valida o payload de pagamento PIX (reserva + hóspede, sem cartão). */
export const validatePix = (body) => validateStayGuest(body);

/** Valida o payload completo do checkout por cartão (reserva + hóspede + cartão). */
export const validateCheckout = (body, maxInstallments) => {
  const stay = validateStayGuest(body);

  const installments = Number(body.installments) || 1;
  if (!Number.isInteger(installments) || installments < 1 || installments > maxInstallments) {
    throw new ValidationError(`Número de parcelas inválido (1 a ${maxInstallments}).`);
  }

  const card = body.card || {};
  const cardNumber = onlyDigits(card.number);
  const cvv = onlyDigits(card.securityCode);
  const expMonth = Number(card.expirationMonth);
  const expYear = Number(card.expirationYear);
  if (cardNumber.length < 13 || cardNumber.length > 19) {
    throw new ValidationError("Número do cartão inválido.");
  }
  if (!String(card.holderName || "").trim()) {
    throw new ValidationError("Nome impresso no cartão é obrigatório.");
  }
  if (!Number.isInteger(expMonth) || expMonth < 1 || expMonth > 12) {
    throw new ValidationError("Mês de validade do cartão inválido.");
  }
  const fullYear = expYear < 100 ? 2000 + expYear : expYear;
  const now = new Date();
  const expDate = new Date(fullYear, expMonth, 0, 23, 59, 59);
  if (Number.isNaN(expDate.getTime()) || expDate < now) {
    throw new ValidationError("Cartão vencido ou validade inválida.");
  }
  if (cvv.length < 3 || cvv.length > 4) {
    throw new ValidationError("Código de segurança (CVV) inválido.");
  }

  return {
    ...stay,
    installments,
    card: {
      number: cardNumber,
      holderName: String(card.holderName).trim(),
      expirationMonth: expMonth,
      expirationYear: fullYear,
      securityCode: cvv
    }
  };
};
