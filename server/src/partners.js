import { config } from "./config.js";

const WEBHOOK_TIMEOUT_MS = 5000;

/**
 * Notifica a Asksuite quando uma reserva e confirmada. O envio e desacoplado
 * do checkout: falha, timeout ou ausencia de configuracao nunca desfazem uma
 * reserva nem atrasam a resposta ao hospede.
 */
export const notifyAsksuiteBooking = async (payload) => {
  const url = config.asksuite.webhookUrl;
  if (!url) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.asksuite.webhookSecret
          ? { Authorization: `Bearer ${config.asksuite.webhookSecret}` }
          : {})
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error("[asksuite] webhook respondeu erro:", response.status, body.slice(0, 300));
      return false;
    }

    console.log("[asksuite] webhook enviado", { booking_id: payload.booking_id });
    return true;
  } catch (error) {
    console.error("[asksuite] falha ao notificar webhook:", error.message);
    return false;
  } finally {
    clearTimeout(timeout);
  }
};

/**
 * Notifica a Asksuite da compra vinculada a uma sessão de atendimento
 * (_askSI) — pedido do Felippe (Asksuite), endpoint confirmado em 18/08/2026:
 * POST https://cookies.asksuite.com/reservation/events, header x-api-key.
 * Fire-and-forget; nunca derruba a reserva. No-op se ASKSUITE_PURCHASE_API_KEY
 * não estiver configurada (nunca chamamos a API deles sem autenticação).
 */
export const notifyAsksuitePurchase = async (payload) => {
  const { purchaseApiUrl: url, purchaseApiKey: key } = config.asksuite;
  if (!url || !key) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error("[asksuite] purchase API respondeu erro:", response.status, body.slice(0, 300));
      return false;
    }

    console.log("[asksuite] purchase API notificada", { ask_si: payload?.session?._askSI });
    return true;
  } catch (error) {
    console.error("[asksuite] falha ao notificar purchase API:", error.message);
    return false;
  } finally {
    clearTimeout(timeout);
  }
};
