import dotenv from "dotenv";

dotenv.config();

const required = ["ARTAX_CLIENT_ID", "ARTAX_CLIENT_SECRET"];

export const config = {
  port: Number(process.env.PORT) || 8080,
  nodeEnv: process.env.NODE_ENV || "development",
  isProduction: process.env.NODE_ENV === "production",

  allowedOrigins: (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),

  artax: {
    baseUrl: (process.env.ARTAX_BASE_URL || "https://artaxnet.com/pms-api/v1").replace(/\/$/, ""),
    clientId: process.env.ARTAX_CLIENT_ID || "",
    clientSecret: process.env.ARTAX_CLIENT_SECRET || "",
    webhookToken: process.env.ARTAX_WEBHOOK_TOKEN || "",
    // Como interpretar o "price" retornado na disponibilidade:
    //   "total"     -> preço já é o total da estadia (padrão, igual ao exemplo da doc)
    //   "per_night" -> preço é por diária; multiplicamos pelo nº de noites
    priceMode: process.env.ARTAX_PRICE_MODE === "per_night" ? "per_night" : "total",
    // Métodos de pagamento do Artax (GET /payment-methods):
    //   5957 = REDE | PIX · 8473 = REDE | CARTÃO DE CRÉDITO
    paymentMethodPix: Number(process.env.ARTAX_PM_PIX) || 5957,
    paymentMethodCard: Number(process.env.ARTAX_PM_CARD) || 8473,
    // Centro de custo opcional para os pagamentos (deixe vazio se não usar).
    costCenterId: Number(process.env.ARTAX_COST_CENTER_ID) || null,
    // Status com que a reserva é criada: 1 Pré-reserva · 2 Confirmado · 3 Hospedado
    // 4 Check-out · 5 Cancelado · 6 No Show. Como só criamos após o pagamento,
    // o padrão é 2 (Confirmado).
    bookingStatus: Number(process.env.ARTAX_BOOKING_STATUS) || 2
  },

  rede: {
    // API v2 unificada (cartão + PIX) — OAuth 2.0 (client_credentials -> Bearer).
    // Em produção: clientId = PV e clientSecret = chave de integração.
    clientId: process.env.REDE_CLIENT_ID || "",
    clientSecret: process.env.REDE_CLIENT_SECRET || "",
    oauthUrl: process.env.REDE_OAUTH_URL || "https://rl7-sandbox-api.useredecloud.com.br/oauth2/token",
    transactionsUrl: (process.env.REDE_TRANSACTIONS_URL || "https://sandbox-erede.useredecloud.com.br/v2/transactions").replace(/\/$/, ""),
    softDescriptor: process.env.REDE_SOFT_DESCRIPTOR || "VilaZanotto",
    // O softDescriptor exige habilitação no portal da Rede. Se não estiver
    // habilitado, enviar causa returnCode 63. Só envia se REDE_SEND_SOFT_DESCRIPTOR=true.
    sendSoftDescriptor: process.env.REDE_SEND_SOFT_DESCRIPTOR === "true",
    maxInstallments: Number(process.env.MAX_INSTALLMENTS) || 6,
    webhookToken: process.env.REDE_WEBHOOK_TOKEN || "",

    // Modo simulação: NÃO chama a Rede; finge pagamento aprovado.
    // Use SOMENTE em testes locais (PAYMENT_SIMULATE=true). A reserva no Artax é REAL.
    simulate: process.env.PAYMENT_SIMULATE === "true"
  },

  // Qual provedor processa o PIX: "itau" (direto no banco, mTLS) ou "rede".
  // Cartão continua sempre na Rede.
  pixProvider: (process.env.PIX_PROVIDER || "rede").toLowerCase(),

  itau: {
    // PIX Recebimentos do Itaú (BACEN) — mTLS + OAuth.
    clientId: process.env.ITAU_CLIENT_ID || "",
    clientSecret: process.env.ITAU_CLIENT_SECRET || "",
    pixKey: process.env.ITAU_PIX_KEY || "",
    oauthUrl: process.env.ITAU_OAUTH_URL || "https://sts.itau.com.br/api/oauth/token",
    baseUrl: (process.env.ITAU_BASE_URL || "https://secure.api.itau/pix_recebimentos/v2").replace(/\/$/, ""),
    // Certificado/chave: em produção via base64 (Railway); em dev via caminho local.
    certB64: process.env.ITAU_CERT_B64 || "",
    keyB64: process.env.ITAU_KEY_B64 || "",
    certPath: process.env.ITAU_CERT_PATH || "",
    keyPath: process.env.ITAU_KEY_PATH || "",
    expiracao: Number(process.env.ITAU_PIX_EXPIRACAO) || 900 // segundos de validade do QR
  },

  // E-mail de confirmação (Resend). Marca por variável (BRAND_*) → mesmo código Casa/Vila.
  // Sem RESEND_API_KEY/RESEND_FROM o envio vira no-op (não quebra a reserva).
  email: {
    apiKey: process.env.RESEND_API_KEY || "",
    from: process.env.RESEND_FROM || "", // ex.: "Vila Zanotto Piri <reservas@seudominio.com>"
    replyTo: process.env.RESEND_REPLY_TO || "",
    bcc: process.env.RESEND_BCC || "", // cópia para a pousada (opcional)
    brandName: process.env.BRAND_NAME || "Vila Zanotto Piri",
    brandColor: process.env.BRAND_COLOR || "#f1bc0e",
    logoUrl: process.env.BRAND_LOGO_URL || "https://checkout-vilazanotto.netlify.app/assets/logo.png",
    siteUrl: process.env.BRAND_SITE_URL || "",
    phone: process.env.BRAND_PHONE || "",
    address: process.env.BRAND_ADDRESS || ""
  }
};

/** Logs a warning for any credential that is still missing so deploys fail loudly. */
export const assertConfig = () => {
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    console.warn(
      `[config] Variáveis de ambiente ausentes: ${missing.join(", ")}. ` +
        "Preencha o .env antes de processar pagamentos reais."
    );
  }
  if (config.rede.simulate) {
    console.warn("[config] ⚠️  PAYMENT_SIMULATE=true — pagamentos SIMULADOS (a Rede NÃO é chamada). A reserva no Artax é REAL.");
  } else if (!config.rede.clientId || !config.rede.clientSecret) {
    console.warn("[config] Credenciais da Rede (REDE_CLIENT_ID/REDE_CLIENT_SECRET) ausentes. Pagamentos reais indisponíveis.");
  }
};
