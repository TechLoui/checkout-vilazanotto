const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.status = 422;
  }
}

const isValidDate = (value) => DATE_RE.test(value) && !Number.isNaN(Date.parse(value));

const toDateOnly = (value) => new Date(`${value}T00:00:00Z`);

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

  const roomId = String(body.room_id || "").trim();
  const rateplanId = Number(body.rateplan_id);
  if (!roomId) throw new ValidationError("Categoria de quarto não informada.");
  if (!Number.isInteger(rateplanId) || rateplanId <= 0) {
    throw new ValidationError("Plano tarifário inválido.");
  }

  const guest = body.guest || {};
  const firstName = String(guest.first_name || "").trim();
  const phone = onlyDigits(guest.phone);
  if (!firstName) throw new ValidationError("Nome do hóspede é obrigatório.");
  if (phone.length < 10) throw new ValidationError("Telefone do hóspede é obrigatório e deve ser válido.");
  const guestType = guest.type === "company" ? "company" : "guest";
  const documentType = ["cpf", "rg", "passport"].includes(guest.document_type) ? guest.document_type : undefined;
  if (guest.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(guest.email)) {
    throw new ValidationError("E-mail do hóspede inválido.");
  }

  return {
    ...base,
    roomId,
    rateplanId,
    comment: String(body.comment || "").slice(0, 500),
    guest: {
      first_name: firstName,
      last_name: String(guest.last_name || "").trim() || undefined,
      document: onlyDigits(guest.document) || undefined,
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
