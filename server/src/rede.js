import { config } from "./config.js";

/**
 * Cliente e.Rede (Rede/Itaú) — API v2 com OAuth 2.0 (Bearer).
 * O MESMO recurso /v2/transactions atende cartão (crédito) e PIX.
 *
 * SEGURANÇA / PCI:
 *  - Os dados do cartão só transitam em memória e seguem direto para a Rede
 *    via HTTPS. Eles NUNCA são gravados em disco, log ou banco.
 *  - Em produção o servidor DEVE rodar atrás de HTTPS.
 *  - Considere habilitar 3DS (autenticação) para reduzir chargebacks.
 */

class RedeError extends Error {
  constructor(message, returnCode, payload) {
    super(message);
    this.name = "RedeError";
    this.returnCode = returnCode;
    this.payload = payload;
  }
}

const parseJsonSafe = async (response) => {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
};

/** Remove campos sensíveis antes de qualquer log. */
const safeForLog = (data) => {
  if (!data || typeof data !== "object") return data;
  const clone = { ...data };
  delete clone.cardNumber;
  delete clone.securityCode;
  delete clone.cardHolderName;
  return clone;
};

/* ---- Simulação (PAYMENT_SIMULATE=true): finge aprovação sem chamar a Rede ---- */
const SIM_QR =
  "00020126580014br.gov.bcb.pix0136simulacao-casa-zanotto@pix5204000053039865802BR5911VilaZanotto6011PIRENOPOLIS62070503***6304SIMU";
const simPix = new Map(); // tid -> { amountCents, reference } (PIX simulado)

/* ===================== OAuth 2.0 (client_credentials) =====================
   Um único access_token (Bearer) é usado em todas as chamadas (cartão e PIX).
   Ele é temporário; renovamos automaticamente com 60s de folga.            */
let accessToken = { value: "", expiresAt: 0 };

export const getAccessToken = async () => {
  const { clientId, clientSecret, oauthUrl } = config.rede;
  if (!clientId || !clientSecret || !oauthUrl) {
    throw new RedeError("Credenciais da Rede (clientId/clientSecret/oauthUrl) não configuradas.", "config");
  }

  const now = Date.now();
  if (accessToken.value && accessToken.expiresAt > now + 60_000) return accessToken.value;

  const basic = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
  const response = await fetch(oauthUrl, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials" })
  });
  const data = await parseJsonSafe(response);

  if (!response.ok || !data.access_token || !data.expires_in) {
    console.warn("[rede] Falha ao gerar access_token:", { status: response.status, error: data.error });
    throw new RedeError(data.error_description || "Falha na autenticação OAuth da Rede.", data.error || String(response.status));
  }

  accessToken = { value: data.access_token, expiresAt: now + Number(data.expires_in) * 1000 };
  return accessToken.value;
};

/** Monta os headers com o Bearer (gera/renova o token sob demanda). */
const authHeaders = async (extra = {}) => ({
  Authorization: `Bearer ${await getAccessToken()}`,
  Accept: "application/json",
  ...extra
});

/* ============================ CARTÃO (crédito) ============================ */

/**
 * PRÉ-AUTORIZA um pagamento de crédito (capture=false): apenas reserva o limite,
 * sem cobrar. A cobrança só acontece na captura (depois da reserva criada).
 *
 * Retornos:
 *  - { ok:true, tid, ... }                -> aprovado (returnCode 00)
 *  - { needs3DS:true, threeDSUrl, tid }   -> exige autenticação 3DS (220)
 *  - lança RedeError                      -> recusado/erro
 */
export const authorize = async ({ amountCents, reference, installments = 1, card }) => {
  if (config.rede.simulate) {
    const tid = "SIMC" + Date.now();
    console.warn("[rede][SIM] Pré-autorização simulada (aprovada):", { tid, reference, amountCents });
    return { ok: true, tid, nsu: "SIMNSU", authorizationCode: "SIM123", reference, returnCode: "00", installments, amountCents };
  }

  const requestBody = {
    capture: false, // pré-autorização (recomendado para reservas)
    kind: "credit",
    reference,
    amount: amountCents,
    installments,
    cardHolderName: card.holderName,
    cardNumber: card.number,
    expirationMonth: card.expirationMonth,
    expirationYear: card.expirationYear,
    securityCode: card.securityCode
  };
  // Só envia softDescriptor se habilitado (senão a Rede recusa com returnCode 63).
  if (config.rede.sendSoftDescriptor && config.rede.softDescriptor) {
    requestBody.softDescriptor = config.rede.softDescriptor;
  }

  const response = await fetch(config.rede.transactionsUrl, {
    method: "POST",
    headers: await authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(requestBody)
  });
  const data = await parseJsonSafe(response);

  // 220 = exige autenticação 3DS (a resposta traz a URL de autenticação).
  if (data.returnCode === "220") {
    const threeDSUrl = data.threeDSecure?.url || data.authentication?.url || data.url || data.urls?.[0]?.href;
    return { needs3DS: true, threeDSUrl, tid: data.tid, reference: data.reference };
  }

  const approved = response.ok && data.returnCode === "00";
  if (!approved) {
    console.warn("[rede] Pré-autorização não aprovada:", safeForLog({ status: response.status, returnCode: data.returnCode, returnMessage: data.returnMessage }));
    throw new RedeError(data.returnMessage || "Pagamento não autorizado pela operadora.", data.returnCode, data);
  }

  return {
    ok: true,
    tid: data.tid,
    nsu: data.nsu,
    authorizationCode: data.authorizationCode,
    reference: data.reference,
    returnCode: data.returnCode,
    installments,
    amountCents
  };
};

/** CAPTURA uma pré-autorização (PUT) — só aqui o cliente é efetivamente cobrado. */
export const capture = async ({ tid, amountCents }) => {
  if (config.rede.simulate) {
    console.warn("[rede][SIM] Captura simulada:", { tid, amountCents });
    return { returnCode: "00", simulated: true };
  }
  const response = await fetch(`${config.rede.transactionsUrl}/${tid}`, {
    method: "PUT",
    headers: await authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ amount: amountCents })
  });
  const data = await parseJsonSafe(response);
  if (!(response.ok && data.returnCode === "00")) {
    console.error("[rede] Falha ao capturar", tid, safeForLog({ returnCode: data.returnCode, returnMessage: data.returnMessage }));
    throw new RedeError(data.returnMessage || "Falha ao capturar o pagamento.", data.returnCode, data);
  }
  return data;
};

/**
 * CANCELA / ESTORNA uma transação. Para uma pré-autorização (não capturada),
 * libera o limite sem o cliente ser cobrado. returnCode 359 = cancelado.
 */
export const refund = async (tid, amountCents) => {
  if (config.rede.simulate) {
    console.warn("[rede][SIM] Estorno/cancelamento simulado:", { tid, amountCents });
    return { returnCode: "00", simulated: true };
  }
  const response = await fetch(`${config.rede.transactionsUrl}/${tid}/refunds`, {
    method: "POST",
    headers: await authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ amount: amountCents })
  });
  const data = await parseJsonSafe(response);
  const ok = response.ok && (data.returnCode === "00" || data.returnCode === "359");
  if (!ok) {
    console.error("[rede] Falha ao cancelar/estornar transação", tid, safeForLog(data));
    throw new RedeError(data.returnMessage || "Falha ao cancelar o pagamento.", data.returnCode, data);
  }
  return data;
};

/* ================================== PIX ================================== */

/**
 * Cria uma cobrança PIX (kind:"pix") e retorna o QR Code (copia-e-cola + imagem).
 * `expiresAt` é um Date (no máx. 15 dias à frente, conforme a Rede).
 */
export const createPix = async ({ amountCents, reference, expiresAt }) => {
  if (config.rede.simulate) {
    const tid = "SIMP" + Date.now();
    simPix.set(tid, { amountCents, reference });
    console.warn("[rede][SIM] PIX simulado criado:", { tid, reference, amountCents });
    return { tid, reference, returnCode: "00", qrCode: SIM_QR, qrImage: "", expiration: expiresAt.toISOString().slice(0, 19), amountCents };
  }

  const requestBody = {
    kind: "pix",
    reference,
    amount: amountCents,
    qrCode: { dateTimeExpiration: expiresAt.toISOString().slice(0, 19) }
  };

  const response = await fetch(config.rede.transactionsUrl, {
    method: "POST",
    headers: await authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(requestBody)
  });
  const data = await parseJsonSafe(response);

  if (!response.ok || data.returnCode !== "00" || !data.tid) {
    console.warn("[rede] Falha ao gerar PIX:", { status: response.status, returnCode: data.returnCode, returnMessage: data.returnMessage });
    throw new RedeError(data.returnMessage || "Não foi possível gerar o PIX.", data.returnCode, data);
  }

  const qr = data.qrCodeResponse || {};
  return {
    tid: data.tid,
    reference: data.reference,
    returnCode: data.returnCode,
    qrCode: qr.qrCodeData || "", // copia-e-cola (EMV)
    qrImage: qr.qrCodeImage || "", // imagem base64 (PNG)
    expiration: qr.dateTimeExpiration || null,
    amountCents
  };
};

/** Consulta uma transação pelo TID (Bearer). Usado para confirmar o PIX. */
export const getPixTransaction = async (tid) => {
  if (config.rede.simulate) {
    const s = simPix.get(tid) || {};
    return { status: "Approved", amount: s.amountCents, reference: s.reference, tid, simulated: true };
  }
  const response = await fetch(`${config.rede.transactionsUrl}/${tid}`, {
    method: "GET",
    headers: await authHeaders()
  });
  const data = await parseJsonSafe(response);
  const st = data?.qrCodeResponse?.status || data?.authorization?.status || data?.status;
  const rc = data?.qrCodeResponse?.returnCode || data?.returnCode;
  // SEMPRE loga (sucesso e falha) p/ não ficarmos cegos no Railway.
  console.log("[rede] getPixTransaction", { tid, http: response.status, status: st, returnCode: rc });
  if (!response.ok) {
    console.warn("[rede] getPixTransaction NÃO OK — corpo:", JSON.stringify(data).slice(0, 400));
    throw new RedeError(data.returnMessage || data?.qrCodeResponse?.returnMessage || "Falha ao consultar a transação PIX.", rc, data);
  }
  return data;
};

/**
 * Normaliza o status do PIX. Na API v2 o status vem DENTRO de qrCodeResponse
 * (ex.: { qrCodeResponse: { status: "Pending" | "Approved" | "Canceled" } }).
 * Cobre também authorization.status e o topo, por segurança.
 */
export const pixStatusOf = (tx) =>
  String(tx?.qrCodeResponse?.status || tx?.authorization?.status || tx?.status || "").trim();
/**
 * Bloco de dados do PIX (amount/reference/tid).
 * Não-pago: vem em qrCodeResponse. PAGO: vem em authorization (sem qrCodeResponse).
 */
export const pixData = (tx) => tx?.authorization || tx?.qrCodeResponse || tx || {};

export { RedeError };
