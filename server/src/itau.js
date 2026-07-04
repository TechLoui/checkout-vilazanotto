import https from "node:https";
import fs from "node:fs";
import { config } from "./config.js";

/**
 * Cliente PIX Recebimentos do Itaú (BACEN) — direto no banco.
 * Autenticação: mTLS (certificado + chave) + OAuth client_credentials.
 * Usa node:https (não fetch) por causa do certificado de cliente (mTLS).
 */

class ItauError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = "ItauError";
    this.status = status;
    this.payload = payload;
  }
}

/* ---- certificado + chave (base64 no Railway, ou caminho local em dev) ---- */
let CERT = null;
let KEY = null;
const loadCerts = () => {
  if (CERT && KEY) return { cert: CERT, key: KEY };
  const { certB64, keyB64, certPath, keyPath } = config.itau;
  CERT = certB64 ? Buffer.from(certB64, "base64") : certPath && fs.existsSync(certPath) ? fs.readFileSync(certPath) : null;
  KEY = keyB64 ? Buffer.from(keyB64, "base64") : keyPath && fs.existsSync(keyPath) ? fs.readFileSync(keyPath) : null;
  if (!CERT || !KEY) {
    throw new ItauError("Certificado/chave do Itaú não configurados (ITAU_CERT_B64/ITAU_KEY_B64).", "config");
  }
  return { cert: CERT, key: KEY };
};

/* ---- request mTLS ---- */
const mtls = (url, { method = "GET", headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const { cert, key } = loadCerts();
    const req = https.request(new URL(url), { method, cert, key, headers }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, text: d }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });

const parseJsonSafe = (t) => {
  try {
    return t ? JSON.parse(t) : {};
  } catch {
    return { raw: t };
  }
};

/* ---- OAuth (token em cache; expira ~300s) ---- */
let token = { value: "", expiresAt: 0 };
export const getItauToken = async () => {
  const now = Date.now();
  if (token.value && token.expiresAt > now + 30_000) return token.value;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.itau.clientId,
    client_secret: config.itau.clientSecret
  }).toString();
  const res = await mtls(config.itau.oauthUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
    body
  });
  const data = parseJsonSafe(res.text);
  if (res.status !== 200 || !data.access_token) {
    console.warn("[itau] OAuth falhou:", res.status, res.text.slice(0, 200));
    throw new ItauError("Falha na autenticação do Itaú (OAuth).", res.status, data);
  }
  token = { value: data.access_token, expiresAt: now + (Number(data.expires_in) || 300) * 1000 };
  return token.value;
};

const apiHeaders = async (extra = {}) => ({
  Authorization: "Bearer " + (await getItauToken()),
  "x-itau-apikey": config.itau.clientId,
  "x-itau-correlationID": Math.random().toString(36).slice(2),
  "x-itau-flowID": "1",
  ...extra
});

/** txid no padrão BACEN (26–35 alfanuméricos). */
export const itauTxid = () =>
  ("CZ" + Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2))
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 30);

/** Cria cobrança imediata (PUT /cob/{txid}) → retorna o copia-e-cola. */
export const createCob = async ({ txid, amountCents, solicitacaoPagador }) => {
  const body = JSON.stringify({
    calendario: { expiracao: config.itau.expiracao },
    valor: { original: (amountCents / 100).toFixed(2) },
    chave: config.itau.pixKey,
    ...(solicitacaoPagador ? { solicitacaoPagador: String(solicitacaoPagador).slice(0, 140) } : {})
  });
  const res = await mtls(`${config.itau.baseUrl}/cob/${txid}`, {
    method: "PUT",
    headers: await apiHeaders({ "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }),
    body
  });
  const data = parseJsonSafe(res.text);
  if (!(res.status === 200 || res.status === 201) || !data.pixCopiaECola) {
    console.warn("[itau] criar cob falhou:", res.status, res.text.slice(0, 300));
    throw new ItauError("Não foi possível gerar a cobrança PIX (Itaú).", res.status, data);
  }
  console.log("[itau] cob criada", { txid: data.txid || txid, status: data.status });
  return { txid: data.txid || txid, pixCopiaECola: data.pixCopiaECola, location: data.location, status: data.status };
};

/** Consulta a cobrança (GET /cob/{txid}). */
export const getCob = async (txid) => {
  const res = await mtls(`${config.itau.baseUrl}/cob/${txid}`, { method: "GET", headers: await apiHeaders() });
  const data = parseJsonSafe(res.text);
  console.log("[itau] getCob", { txid, http: res.status, status: data?.status });
  if (res.status !== 200) {
    console.warn("[itau] consulta cob NÃO OK:", res.text.slice(0, 200));
    throw new ItauError("Falha ao consultar a cobrança PIX (Itaú).", res.status, data);
  }
  return data;
};

/** Status do cob: ATIVA | CONCLUIDA | REMOVIDA_PELO_USUARIO_RECEBEDOR | REMOVIDA_PELO_PSP. */
export const cobStatus = (cob) => String(cob?.status || "").trim().toUpperCase();
export const cobPaid = (cob) => cobStatus(cob) === "CONCLUIDA";
export const cobCanceled = (cob) => cobStatus(cob).startsWith("REMOVIDA");

/** Cadastra a URL de webhook para a chave PIX (PUT /webhook/{chave}). Self-service. */
export const registerWebhook = async (url) => {
  const body = JSON.stringify({ webhookUrl: url });
  const res = await mtls(`${config.itau.baseUrl}/webhook/${config.itau.pixKey}`, {
    method: "PUT",
    headers: await apiHeaders({ "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }),
    body
  });
  console.log("[itau] registerWebhook", { status: res.status, body: res.text.slice(0, 200) });
  return { status: res.status, body: res.text };
};

export { ItauError };
