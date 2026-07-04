import crypto from "node:crypto";
import { config } from "./config.js";

/**
 * Valida a assinatura de um webhook recebido do Artax.
 *  - Bearer token no header Authorization deve bater com ARTAX_WEBHOOK_TOKEN.
 *  - X-Signature = HMAC-SHA256(rawBody, ARTAX_WEBHOOK_TOKEN) em hex.
 * Usa comparação em tempo constante para evitar timing attacks.
 *
 * IMPORTANTE: precisa do corpo CRU (Buffer), por isso a rota usa express.raw.
 */
export const verifyArtaxWebhook = (req) => {
  const token = config.artax.webhookToken;
  if (!token) {
    return { ok: false, reason: "ARTAX_WEBHOOK_TOKEN não configurado no servidor." };
  }

  const authHeader = req.get("authorization") || "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (bearer !== token) {
    return { ok: false, reason: "Bearer token inválido." };
  }

  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
  const expected = crypto.createHmac("sha256", token).update(rawBody).digest("hex");
  const received = (req.get("x-signature") || "").trim().toLowerCase();

  const expectedBuf = Buffer.from(expected, "hex");
  const receivedBuf = Buffer.from(received, "hex");
  if (expectedBuf.length !== receivedBuf.length || !crypto.timingSafeEqual(expectedBuf, receivedBuf)) {
    return { ok: false, reason: "Assinatura X-Signature inválida." };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return { ok: false, reason: "Corpo não é um JSON válido." };
  }

  return { ok: true, payload };
};

/**
 * Trata o evento do webhook. Aqui você conecta sua lógica de negócio:
 * atualizar banco, disparar e-mail de confirmação/cancelamento, etc.
 */
export const handleArtaxEvent = (payload) => {
  const { event, data } = payload || {};
  switch (event) {
    case "booking_created":
      console.log(`[webhook] Reserva criada: ${data?.booking_id} em ${data?.timestamp}`);
      // TODO: persistir/confirmar e-mail ao hóspede.
      break;
    case "booking_canceled":
      console.log(`[webhook] Reserva cancelada: ${data?.booking_id} em ${data?.timestamp}`);
      // TODO: liberar recursos, registrar cancelamento, avisar equipe.
      break;
    default:
      console.log("[webhook] Evento não tratado:", event);
  }
};
