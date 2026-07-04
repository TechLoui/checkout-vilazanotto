import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";

import { config, assertConfig } from "./config.js";
import { validateAvailability, validateCheckout, validatePix, ValidationError } from "./validation.js";
import { checkAvailability, listCostCenters, ArtaxError } from "./artaxnet.js";
import { RedeError } from "./rede.js";
import { processCheckout, createPixCharge, confirmPix, reconcilePendingPix } from "./bookingFlow.js";
import { verifyArtaxWebhook, handleArtaxEvent } from "./webhooks.js";

assertConfig();

const app = express();
app.set("trust proxy", 1);
app.use(helmet());

// CORS restrito às origens do site.
app.use(
  cors({
    origin(origin, callback) {
      // Permite ferramentas locais (sem Origin) e as origens autorizadas.
      if (!origin || config.allowedOrigins.length === 0 || config.allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Origem não autorizada pelo CORS."));
    }
  })
);

/* ----------------------------------------------------------------------------
   Webhook do Artax — precisa do corpo CRU para validar a assinatura HMAC.
   Registrado ANTES do express.json para não perder o raw body.
---------------------------------------------------------------------------- */
app.post("/api/webhooks/artax", express.raw({ type: "*/*", limit: "64kb" }), (req, res) => {
  const result = verifyArtaxWebhook(req);
  if (!result.ok) {
    console.warn("[webhook] Rejeitado:", result.reason);
    return res.status(401).json({ error: result.reason });
  }
  try {
    handleArtaxEvent(result.payload);
  } catch (error) {
    console.error("[webhook] Erro ao processar evento:", error);
  }
  // Responder 200 rápido (< 5s) confirma a entrega ao Artax.
  return res.status(200).json({ received: true });
});

// Parser JSON para as demais rotas.
app.use(express.json({ limit: "32kb" }));

// Rate limit defensivo (o Artax também limita 100 req/60s do nosso lado).
const apiLimiter = rateLimit({ windowMs: 60_000, max: 80, standardHeaders: true, legacyHeaders: false });
app.use("/api/", apiLimiter);

app.get("/api/health", (req, res) => res.json({ ok: true, env: config.nodeEnv }));

// Normaliza o preço para TOTAL da estadia quando o Artax devolve por diária,
// para o front sempre exibir o valor que será cobrado.
const normalizeTotals = (data, nights) => {
  if (config.artax.priceMode !== "per_night" || !data?.rooms || Array.isArray(data.rooms)) {
    return data;
  }
  for (const plans of Object.values(data.rooms)) {
    for (const opt of Object.values(plans)) {
      if (Number.isFinite(Number(opt.price))) {
        opt.price = Number((Number(opt.price) * nights).toFixed(2));
      }
    }
  }
  return data;
};

// Disponibilidade de quartos.
app.get("/api/availability", async (req, res, next) => {
  try {
    const params = validateAvailability({
      arrival_date: req.query.arrival_date,
      departure_date: req.query.departure_date,
      adults: req.query.adults,
      kids: req.query.kids,
      ages: [].concat(req.query.ages || []).filter((v) => v !== "")
    });
    const data = await checkAvailability(params);
    const nights = Math.max(1, Math.round((new Date(params.departure_date) - new Date(params.arrival_date)) / 86_400_000));
    res.json(normalizeTotals(data, nights));
  } catch (error) {
    next(error);
  }
});

// Checkout por CARTÃO: cobra na Rede e cria a reserva no Artax (só se aprovado).
app.post("/api/checkout", async (req, res, next) => {
  try {
    const input = validateCheckout(req.body, config.rede.maxInstallments);
    const result = await processCheckout(input);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

// PIX: gera o QR Code da cobrança (a reserva só é criada após o pagamento).
app.post("/api/pix/create", async (req, res, next) => {
  try {
    const input = validatePix(req.body);
    const result = await createPixCharge(input);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

// PIX: confirma o pagamento; se pago, cria a reserva no Artax e devolve o id.
app.post("/api/pix/status", async (req, res, next) => {
  try {
    const tid = String(req.body?.tid || "").trim();
    if (!tid) throw new ValidationError("Identificador do PIX não informado.");
    // Evita cache de proxy/navegador devolvendo um "pending" antigo.
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.json(await confirmPix(tid));
  } catch (error) {
    next(error);
  }
});

// Webhook PIX da Rede: evento PV.UPDATE_TRANSACTION_PIX -> confirma e cria a reserva.
// Autenticação por Bearer (REDE_WEBHOOK_TOKEN). Responde 200 rápido e processa depois.
app.post("/api/webhooks/erede/pix", (req, res) => {
  const expected = config.rede.webhookToken;
  if (expected && req.header("authorization") !== `Bearer ${expected}`) {
    console.warn("[webhook:pix] 401 — token inválido ou ausente");
    return res.status(401).json({ error: "Unauthorized" });
  }
  const events = Array.isArray(req.body?.events) ? req.body.events : [];
  const tid = req.body?.data?.id || req.body?.data?.tid;
  console.log("[webhook:pix] evento recebido", { events, "data.id": tid });
  res.status(200).json({ received: true });

  if (events.includes("PV.UPDATE_TRANSACTION_PIX") && tid) {
    confirmPix(String(tid))
      .then((r) => console.log("[webhook:pix] confirmPix ->", { status: r.status, booking_id: r.booking_id }))
      .catch((error) => console.error("[webhook:pix] falha ao confirmar:", error.message));
  }
  if (events.includes("PV.REFUND_PIX")) {
    console.log("[webhook:pix] devolução/cancelamento notificado", { "data.id": tid });
  }
});

// Webhook PIX do Itaú (BACEN): recebe os pix recebidos e confirma cada txid.
// Sem token: revalidamos cada txid consultando a cobrança no Itaú (autoritativo).
app.post("/api/webhooks/itau/pix", (req, res) => {
  const pixArr = Array.isArray(req.body?.pix) ? req.body.pix : [];
  console.log("[webhook:itau] recebido", { qtd: pixArr.length });
  res.status(200).json({ received: true });
  for (const p of pixArr) {
    const tid = p?.txid;
    if (!tid) continue;
    confirmPix(String(tid))
      .then((r) => console.log("[webhook:itau] confirmPix ->", { status: r.status, booking_id: r.booking_id }))
      .catch((e) => console.error("[webhook:itau] erro:", e.message));
  }
});

// Centros de custo (útil para o painel; opcional).
app.get("/api/cost-centers", async (req, res, next) => {
  try {
    res.json(await listCostCenters());
  } catch (error) {
    next(error);
  }
});

// Tratamento central de erros — mensagens seguras, sem vazar internals.
app.use((error, req, res, _next) => {
  if (error instanceof ValidationError) {
    return res.status(422).json({ error: error.message });
  }
  if (error instanceof RedeError) {
    console.warn("[server] RedeError:", { code: error.returnCode, message: error.message });
    return res.status(402).json({ error: error.message, code: error.returnCode });
  }
  if (error instanceof ArtaxError) {
    return res.status(error.status >= 400 ? error.status : 502).json({ error: error.message });
  }
  if (error?.message?.includes("CORS")) {
    return res.status(403).json({ error: error.message });
  }
  console.error("[server] Erro não tratado:", error);
  return res.status(error.status || 500).json({
    error: error.status ? error.message : "Erro interno. Tente novamente em instantes."
  });
});

app.listen(config.port, () => {
  console.log(`Vila Zanotto Piri checkout API rodando na porta ${config.port} (${config.nodeEnv})`);
});

// Reconciliação periódica do PIX: confirma pagamentos mesmo se o cliente fechou
// a página (e o webhook ainda não estiver cadastrado). Idempotente.
const PIX_RECONCILE_MS = Number(process.env.PIX_RECONCILE_MS) || 60_000;
setInterval(() => {
  reconcilePendingPix().catch((err) => console.warn("[pix] reconcile erro:", err.message));
}, PIX_RECONCILE_MS).unref();
