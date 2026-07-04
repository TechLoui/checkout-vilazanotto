import { config } from "./config.js";

/**
 * Envio de e-mail de confirmação de reserva via Resend (HTTP API, sem SDK).
 * Seguro por padrão: se RESEND_API_KEY/RESEND_FROM não estiverem setados, faz
 * no-op (loga aviso) — nunca derruba o fluxo de reserva. Marca por variável de
 * ambiente (BRAND_*), então o mesmo código serve Casa e Vila.
 */

const RESEND_URL = "https://api.resend.com/emails";

const brl = (v) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** "sex, 05 de dez de 2026" — parse YYYY-MM-DD como data local (evita off-by-one). */
const fmtDate = (iso) => {
  const [y, m, d] = String(iso || "").split("-").map(Number);
  if (!y || !m || !d) return String(iso || "");
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
};

const cleanRoom = (name) => String(name || "").split("|")[0].trim();
const guestsLabel = (adults, kids) =>
  `${adults} adulto(s)${Number(kids) ? ` · ${kids} criança(s)` : ""}`;
const methodLabel = (m) => (m === "pix" ? "PIX" : "Cartão de crédito");

export const isEmailEnabled = () => Boolean(config.email.apiKey && config.email.from);

/* ------------------------------- template ------------------------------- */
export const renderHtml = (d) => {
  const brand = esc(config.email.brandName);
  const color = config.email.brandColor || "#c8991f";
  const room = esc(cleanRoom(d.roomName));
  const logo = config.email.logoUrl
    ? `<img src="${esc(config.email.logoUrl)}" alt="${brand}" height="80" style="height:80px;width:auto;max-width:300px;display:block;margin:0 auto;border:0;outline:none;">`
    : `<div style="font:700 22px/1.2 Georgia,serif;color:#1e1a17;text-align:center;">${brand}</div>`;

  const row = (label, value, strong = false) => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #eee;color:#6b6b6b;font:400 14px/1.4 Arial,sans-serif;">${esc(label)}</td>
      <td style="padding:10px 0;border-bottom:1px solid #eee;color:#1e1a17;font:${strong ? "700" : "500"} 14px/1.4 Arial,sans-serif;text-align:right;">${value}</td>
    </tr>`;

  const contactBits = [
    config.email.phone ? `Telefone/WhatsApp: ${esc(config.email.phone)}` : "",
    config.email.address ? esc(config.email.address) : "",
    config.email.siteUrl ? `<a href="${esc(config.email.siteUrl)}" style="color:${color};text-decoration:none;">${esc(config.email.siteUrl.replace(/^https?:\/\//, ""))}</a>` : ""
  ].filter(Boolean).join(" &nbsp;·&nbsp; ");

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">Sua reserva na ${brand} está confirmada — ${room}, ${fmtDate(d.checkIn)} a ${fmtDate(d.checkOut)}.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 6px 24px rgba(0,0,0,.06);">
        <tr><td style="height:6px;background:${color};font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td style="background:#ffffff;padding:22px 24px;text-align:center;border-bottom:1px solid #f1f1f1;">${logo}</td></tr>
        <tr><td style="padding:32px 32px 8px;">
          <p style="margin:0 0 4px;color:${color};font:700 13px/1.2 Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;">Reserva confirmada</p>
          <h1 style="margin:0 0 12px;color:#1e1a17;font:700 26px/1.25 Georgia,serif;">Tudo certo, ${esc(d.guestName?.split(" ")[0] || "olá")}! 🎉</h1>
          <p style="margin:0 0 20px;color:#4a4a4a;font:400 15px/1.6 Arial,sans-serif;">
            Recebemos seu pagamento e sua reserva na <strong>${brand}</strong> está confirmada.
            Guarde este e-mail — ele é o seu comprovante.
          </p>
        </td></tr>
        <tr><td style="padding:0 32px 8px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid ${color};">
            ${row("Reserva nº", `<strong>#${esc(d.bookingId)}</strong>`)}
            ${row("Check-in", esc(fmtDate(d.checkIn)))}
            ${row("Check-out", esc(fmtDate(d.checkOut)))}
            ${row("Noites", esc(d.nights))}
            ${row("Acomodação", room)}
            ${row("Hóspedes", esc(guestsLabel(d.adults, d.kids)))}
            ${row("Pagamento", esc(methodLabel(d.method)))}
            ${row("Total pago", `<span style="color:${color};">${esc(brl(d.totalPrice))}</span>`, true)}
          </table>
        </td></tr>
        ${contactBits ? `<tr><td style="padding:16px 32px 0;"><p style="margin:0;color:#6b6b6b;font:400 13px/1.6 Arial,sans-serif;">${contactBits}</p></td></tr>` : ""}
        <tr><td style="padding:24px 32px 32px;">
          <p style="margin:0;color:#9a9a9a;font:400 12px/1.5 Arial,sans-serif;">
            Você recebeu este e-mail porque fez uma reserva na ${brand}. Este é um comprovante automático de confirmação.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
};

const renderText = (d) =>
  [
    `RESERVA CONFIRMADA — ${config.email.brandName}`,
    ``,
    `Tudo certo, ${d.guestName?.split(" ")[0] || "olá"}! Recebemos seu pagamento e sua reserva está confirmada.`,
    ``,
    `Reserva nº: #${d.bookingId}`,
    `Check-in:   ${fmtDate(d.checkIn)}`,
    `Check-out:  ${fmtDate(d.checkOut)}`,
    `Noites:     ${d.nights}`,
    `Acomodação: ${cleanRoom(d.roomName)}`,
    `Hóspedes:   ${guestsLabel(d.adults, d.kids)}`,
    `Pagamento:  ${methodLabel(d.method)}`,
    `Total pago: ${brl(d.totalPrice)}`,
    ``,
    config.email.phone ? `Contato: ${config.email.phone}` : "",
    config.email.siteUrl || ""
  ].filter((l) => l !== undefined).join("\n");

/* ------------------------------- envio ------------------------------- */
export const sendBookingConfirmation = async (d) => {
  if (!isEmailEnabled()) {
    console.warn("[email] Resend não configurado (RESEND_API_KEY/RESEND_FROM). E-mail de confirmação NÃO enviado.");
    return false;
  }
  if (!d?.to) {
    console.warn("[email] hóspede sem e-mail — confirmação não enviada.", { booking: d?.bookingId });
    return false;
  }

  const payload = {
    from: config.email.from,
    to: [d.to],
    subject: `✅ Reserva confirmada · ${config.email.brandName} · ${fmtDate(d.checkIn)}`,
    html: renderHtml(d),
    text: renderText(d),
    ...(config.email.replyTo ? { reply_to: config.email.replyTo } : {}),
    ...(config.email.bcc ? { bcc: [config.email.bcc] } : {})
  };

  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.email.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error("[email] Resend falhou:", res.status, JSON.stringify(body).slice(0, 300));
      return false;
    }
    console.log("[email] confirmação enviada", { id: body.id, to: d.to, booking: d.bookingId });
    return true;
  } catch (err) {
    console.error("[email] erro ao enviar confirmação:", err.message);
    return false;
  }
};
