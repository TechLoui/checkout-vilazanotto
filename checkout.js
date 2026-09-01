/* ===========================================================================
   Checkout transparente — Villa Zanotto Piri
   Fluxo: disponibilidade -> escolha do quarto -> dados+cartão -> confirmação.
   O backend (Node) cobra na Rede e cria a reserva no Artax só se aprovado.
   ===========================================================================
   CONFIG: defina a URL do backend. Em produção, aponte para o seu domínio,
   por ex.: window.VZ_CHECKOUT_API = "https://api.vilazanottopiri.com/api";
=========================================================================== */
const API_BASE = (
  window.VZ_CHECKOUT_API ||
  (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? "http://localhost:8080/api" : "/api")
).replace(/\/$/, "");
let INSTALLMENTS_MAX = 4;
const DEFAULT_SUMMARY_IMAGE = "assets/logo.png";
const LOGO_IMAGE = "assets/logo.png";
const FALLBACK_ROOM_IMAGES = [
  "assets/gallery/5-2-scaled.webp",
  "assets/gallery/Flat-4-scaled.webp",
  "assets/gallery/1-2-1-scaled.webp",
  "assets/gallery/10-2-scaled.webp",
  "assets/gallery/Flat-43-scaled.webp",
  "assets/gallery/13-1-scaled.webp",
  "assets/gallery/Flat-36-scaled.webp",
  "assets/gallery/Flat-45-scaled.webp"
];

// Mantém o seletor de parcelas sincronizado com MAX_INSTALLMENTS do Railway.
// O fallback preserva o checkout caso o backend ainda não tenha /api/config.
const loadPublicConfig = async () => {
  try {
    const response = await fetch(`${API_BASE}/config`);
    if (!response.ok) return;
    const data = await readJSON(response);
    const max = Number(data.maxInstallments);
    if (Number.isInteger(max) && max >= 1 && max <= 12) {
      const selectedInstallments = Number($("#c-inst")?.value) || 1;
      INSTALLMENTS_MAX = max;
      const installmentLabel = $("[data-card-installments]");
      if (installmentLabel) installmentLabel.textContent = max === 1 ? "Pagamento à vista" : `Em até ${max}x sem juros`;
      if (cartCount()) {
        buildInstallments(cartTotal());
        if (selectedInstallments <= max) $("#c-inst").value = String(selectedInstallments);
      }
    }
  } catch (_) {
    // Configuração pública é um aprimoramento; falhas não interrompem a reserva.
  }
};

const brl = (value) =>
  Number(value).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

const escapeHTML = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));

const readJSON = async (response) => {
  try {
    return await response.json();
  } catch (_) {
    throw new Error("O serviço de reservas respondeu de forma inesperada. Tente novamente em instantes.");
  }
};

const encodeRoomData = (room) => encodeURIComponent(JSON.stringify(room));
const decodeRoomData = (value) => JSON.parse(decodeURIComponent(value));

const state = {
  search: null, // { arrival_date, departure_date, adults, kids, ages }
  selectedRooms: [] // [{ roomId, rateplanId, room_name, price, images }]
};

/* ---------- carrinho de acomodações (seleção múltipla) ----------
   A identidade de um item é roomId + rateplanId, e a seleção é um toggle —
   nunca uma quantidade. Isso impede escolher duas vezes o MESMO tipo, que a
   API do Artax não suporta (room_units é indexado por room_type_id, então
   cada tipo só cabe uma vez por reserva). Mesmo desenho do site da Casa. */
const sameRoom = (a, b) =>
  String(a.roomId) === String(b.roomId) && String(a.rateplanId) === String(b.rateplanId);
const isRoomSelected = (opt) => state.selectedRooms.some((r) => sameRoom(r, opt));
const cartCount = () => state.selectedRooms.length;
const cartTotal = () => state.selectedRooms.reduce((sum, r) => sum + Number(r.price || 0), 0);
const cartLabel = () => {
  if (!cartCount()) return "Sua reserva";
  if (cartCount() === 1) return state.selectedRooms[0].room_name;
  return `${cartCount()} acomodações`;
};
const cartImage = () => {
  const first = state.selectedRooms[0];
  return first?.images?.[0] || first?.image || LOGO_IMAGE;
};

const refreshIcons = () => window.lucide && window.lucide.createIcons();
const focusHeading = (element) => {
  if (!element) return;
  window.requestAnimationFrame(() => element.focus({ preventScroll: true }));
};

const isEmbeddedCheckout = () => document.body.classList.contains("embed");
const embedTargetOrigin = window.location.origin;
let embedViewFrame = 0;
let pendingEmbedView = null;
let lastEmbedHeight = 0;

const postEmbedHeight = () => {
  if (!isEmbeddedCheckout()) return;
  const height = Math.ceil(document.body.getBoundingClientRect().height);
  if (Math.abs(height - lastEmbedHeight) < 2) return;
  lastEmbedHeight = height;
  parent.postMessage({ cz: "height", value: height }, embedTargetOrigin);
};

const notifyEmbedView = (step, topic) => {
  document.body.dataset.step = String(step);
  document.body.dataset.topic = topic;
  if (!isEmbeddedCheckout()) return;

  pendingEmbedView = { step, topic };
  if (embedViewFrame) return;
  embedViewFrame = window.requestAnimationFrame(() => {
    embedViewFrame = 0;
    parent.postMessage({ cz: "view", ...pendingEmbedView }, embedTargetOrigin);
    pendingEmbedView = null;
    window.requestAnimationFrame(postEmbedHeight);
  });
};

/* ---------- navegação entre etapas ---------- */
const goToStep = (step) => {
  document.body.dataset.step = String(step);
  $$("[data-view]").forEach((v) => v.classList.toggle("is-hidden", Number(v.dataset.view) !== step));
  $$(".steps [data-step]").forEach((chip) => {
    const n = Number(chip.dataset.step);
    chip.classList.toggle("is-active", n === step);
    chip.classList.toggle("is-done", n < step);
    chip.setAttribute("aria-current", n === step ? "step" : "false");
  });
  const liveStatus = $("[data-checkout-status]");
  if (liveStatus) {
    const labels = ["Disponibilidade", "Escolha da acomodação", "Pagamento", "Confirmação"];
    liveStatus.textContent = `Etapa ${step} de 4: ${labels[step - 1]}.`;
  }
  requestAnimationFrame(() => {
    const active = $(`[data-view="${step}"]`);
    active?.scrollTo?.({ top: 0 });
    active?.querySelector("form, .room-list")?.scrollTo?.({ top: 0 });
  });
  if (isEmbeddedCheckout()) {
    const topics = {
      1: "availability:dates",
      2: "rooms",
      3: "payment:guest",
      4: "confirmation"
    };
    notifyEmbedView(step, topics[step] || `step:${step}`);
  } else {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  focusHeading($(`[data-view="${step}"] h2`));
};

/* Modo embed: checkout dentro de um iframe no próprio site. */
const initEmbed = () => {
  if (!new URLSearchParams(location.search).has("embed")) return;
  document.body.classList.add("embed");
  if ("ResizeObserver" in window) new ResizeObserver(postEmbedHeight).observe(document.body);
  window.addEventListener("load", postEmbedHeight);
  window.addEventListener("resize", postEmbedHeight);
  notifyEmbedView(Number(document.body.dataset.step) || 1, document.body.dataset.topic || "availability:dates");
  setTimeout(postEmbedHeight, 300);
};

const showNotice = (message, type = "error") => {
  const el = $("#notice");
  el.textContent = message;
  el.className = `notice ${type}`;
};
const clearNotice = () => $("#notice").classList.add("is-hidden");

const invalidateField = (field, message) => {
  showNotice(message);
  field?.setAttribute("aria-invalid", "true");
  field?.focus({ preventScroll: true });
  field?.scrollIntoView({ behavior: "smooth", block: "center" });
  return false;
};

/* ---------- janela de "sem disponibilidade" ---------- */
let noAvailabilityTrigger = null;
const showNoAvailability = () => {
  const m = $("[data-noavail]");
  if (!m) return;
  noAvailabilityTrigger = document.activeElement;
  m.hidden = false;
  document.body.classList.add("modal-open");
  refreshIcons();
  m.querySelector(".cz-modal-card [data-noavail-close]")?.focus();
};
const closeNoAvailability = () => {
  const m = $("[data-noavail]");
  if (!m || m.hidden) return;
  m.hidden = true;
  document.body.classList.remove("modal-open");
  if (noAvailabilityTrigger instanceof HTMLElement) noAvailabilityTrigger.focus();
  noAvailabilityTrigger = null;
};

/* ---------- revisão da reserva (antes do pagamento, mobile) ---------- */
const updateReview = () => {
  const s = state.search;
  if (!s) return;
  const setT = (sel, v) => { const el = $(sel); if (el) el.textContent = v; };
  setT("[data-pr-in]", fmtDate(s.arrival_date));
  setT("[data-pr-out]", fmtDate(s.departure_date));
  setT("[data-pr-nights]", String(nightsBetween(s.arrival_date, s.departure_date)));
  setT("[data-pr-guests]", `${s.adults} adulto(s)${s.kids ? ` · ${s.kids} criança(s)` : ""}`);
  if (cartCount()) {
    setT("[data-pr-room]", cartLabel());
    setT("[data-pr-total]", brl(cartTotal()));
  }
};

/* ---------- datas / resumo ---------- */
const fmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
};
const nightsBetween = (a, b) =>
  Math.max(0, Math.round((new Date(b) - new Date(a)) / 86400000));

// Sem quarto selecionado, mostra a logo (contain) no lugar da foto.
const setSummaryMedia = (src, isLogo) => {
  const img = $("#sum-image");
  if (!img) return;
  img.src = src;
  img.closest(".summary-media")?.classList.toggle("is-logo", !!isLogo);
};

const updateSummary = () => {
  const s = state.search;
  if (!s) {
    setSummaryMedia(LOGO_IMAGE, true);
    return;
  }
  $("#sum-in").textContent = fmtDate(s.arrival_date);
  $("#sum-out").textContent = fmtDate(s.departure_date);
  $("#sum-nights").textContent = nightsBetween(s.arrival_date, s.departure_date);
  $("#sum-guests").textContent =
    `${s.adults} adulto(s)${s.kids ? ` · ${s.kids} criança(s)` : ""}`;
  if (cartCount()) {
    $("#sum-room").textContent = cartLabel();
    $("#sum-total").textContent = brl(cartTotal());
    const img = $("#sum-image");
    if (img) img.alt = cartLabel() || "Acomodação selecionada";
    setSummaryMedia(cartImage(), false);
  } else {
    $("#sum-room").textContent = "Sua reserva";
    $("#sum-total").textContent = "—";
    const img = $("#sum-image");
    if (img) img.alt = "Villa Zanotto Piri";
    setSummaryMedia(LOGO_IMAGE, true);
  }
};

/* Identificador de sessão da Asksuite (_askSI) — presente no link direto que
   a IA deles gera. Guardado em sessionStorage pra sobreviver às etapas do
   checkout e ser enviado no /checkout e /pix/create, permitindo à Asksuite
   vincular a compra ao atendimento (mesma chave usada na Casa Zanotto,
   confirmada pelo Felippe em 19/08/2026 como válida pra todos os clientes). */
const VZ_ASK_SI_KEY = "vz_ask_si";
const captureAskSi = () => {
  try {
    const p = new URLSearchParams(location.search);
    const askSi = p.get("_askSI") || p.get("_askSi") || p.get("askSI");
    if (askSi) sessionStorage.setItem(VZ_ASK_SI_KEY, askSi);
  } catch (_) {
    /* sessionStorage indisponível (modo privado etc.) — segue sem rastreio */
  }
};
const getAskSi = () => {
  try {
    return sessionStorage.getItem(VZ_ASK_SI_KEY) || "";
  } catch (_) {
    return "";
  }
};

/* ---------- prefill via query string (vindo do site) ---------- */
const prefillFromQuery = () => {
  captureAskSi();
  const p = new URLSearchParams(location.search);
  const arrival = p.get("arrival_date") || p.get("entrada");
  const departure = p.get("departure_date") || p.get("saida");
  const adults = p.get("adults") || p.get("hospedes");
  const kids = p.get("kids") || p.get("children");
  const ages = [...p.entries()]
    .filter(([key]) => /^ages\[\d+\]$/.test(key) || key === "ages[]")
    .map(([key, value], index) => ({
      index: key === "ages[]" ? index : Number(key.match(/\d+/)?.[0] || index),
      value
    }))
    .sort((a, b) => a.index - b.index)
    .map((item) => item.value);
  if (arrival) $("#arrival").value = arrival;
  if (departure) $("#departure").value = departure;
  if (adults && Number(adults) >= 1) $("#adults").value = String(Math.min(Number(adults), 9));
  if (kids && Number(kids) >= 0) {
    $("#kids").value = String(Math.min(Number(kids), 6));
    buildAgesInputs();
    $$("#ages-inputs [data-age]").forEach((input, index) => {
      if (ages[index] != null) input.value = String(Math.max(0, Math.min(5, Number(ages[index]) || 0)));
    });
  }

  // Sem pré-seleção de datas: o calendário começa vazio (a menos que venham
  // datas por query string). Só define a data mínima (hoje).
  $("#arrival").min = new Date().toISOString().slice(0, 10);
};

const buildAgesInputs = () => {
  const kids = Number($("#kids").value);
  const wrap = $("#ages-wrap");
  const container = $("#ages-inputs");
  container.innerHTML = "";
  if (!kids) { wrap.classList.add("is-hidden"); return; }
  wrap.classList.remove("is-hidden");
  for (let i = 0; i < kids; i += 1) {
    const field = document.createElement("div");
    field.className = "field";
    const inputId = `child-age-${i + 1}`;
    field.innerHTML = `<label for="${inputId}">Idade da criança ${i + 1}</label>
      <input id="${inputId}" name="ages[]" type="number" min="0" max="5" value="5" data-age inputmode="numeric" required>`;
    container.appendChild(field);
  }
};

/* ---------- etapa 1: disponibilidade (sub-passos datas -> hóspedes) ---------- */
const goToSearchStep = (name) => {
  $$("[data-searchstep]").forEach((p) => p.classList.toggle("is-hidden", p.dataset.searchstep !== name));
  const t = $("[data-searchtitle]");
  const intro = $("[data-searchintro]");
  if (t) t.textContent = name === "guests" ? "Quantos hóspedes?" : "Quando você vem?";
  if (intro) intro.textContent = name === "guests" ? "Informe adultos e crianças." : "Escolha as datas da estadia.";
  refreshIcons();
  focusHeading(t);
  notifyEmbedView(1, `availability:${name}`);
};

const buildAvailabilityParams = (search) => {
  const params = new URLSearchParams({
    arrival_date: search.arrival_date,
    departure_date: search.departure_date,
    adults: String(search.adults),
    kids: String(search.kids)
  });
  (search.ages || []).forEach((age, i) => params.append(`ages[${i}]`, String(age)));
  return params;
};

/** Consulta a disponibilidade e renderiza a lista; devolve a qtd de quartos. */
const runAvailability = async (search) => {
  const res = await fetch(`${API_BASE}/availability?${buildAvailabilityParams(search).toString()}`);
  const data = await readJSON(res);
  if (!res.ok) throw new Error(data.error || "Falha ao consultar disponibilidade.");
  state.search = search;
  const list = flattenRooms(data.rooms);
  renderRooms(data.rooms);
  return list.length;
};

const fetchAvailability = async (event) => {
  // Também é chamada sem evento, pelo deep-link (ver DOMContentLoaded).
  event?.preventDefault();
  clearNotice();
  const btn = $("#search-btn");
  const ages = $$("#ages-inputs [data-age]").map((i) => Number(i.value));
  const search = {
    arrival_date: $("#arrival").value,
    departure_date: $("#departure").value,
    adults: Number($("#adults").value),
    kids: Number($("#kids").value),
    ages
  };

  if (nightsBetween(search.arrival_date, search.departure_date) < 1) {
    return showNotice("O check-out deve ser pelo menos um dia após o check-in.");
  }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Buscando...';
  try {
    const count = await runAvailability(search);
    state.selectedRooms = [];
    updateRoomCart();
    updateSummary();
    if (!count) {
      persistState();
      showNoAvailability();
      return;
    }
    goToStep(2);
    persistState();
  } catch (err) {
    showNotice(err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="search"></i> Buscar quartos';
    refreshIcons();
  }
};

const toImageList = (value) => {
  if (!value) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(toImageList);
  if (typeof value === "object") {
    const keys = ["url", "src", "href", "path", "image", "main_image", "large", "medium", "thumbnail", "thumb"];
    return keys.flatMap((key) => toImageList(value[key]));
  }
  return [];
};

const normalizeImageUrl = (src) => {
  const value = String(src || "").trim();
  if (!value) return "";
  if (value.startsWith("//")) return `https:${value}`;
  return value;
};

const isImageUrl = (src) =>
  /^(https?:)?\/\//i.test(src) || /\.(webp|avif|png|jpe?g)(\?.*)?$/i.test(src);

const extractArtaxImages = (option) => {
  const keys = [
    "main_image",
    "image",
    "photo",
    "picture",
    "cover",
    "cover_image",
    "thumbnail",
    "thumb",
    "images",
    "photos",
    "pictures",
    "gallery",
    "media",
    "room_images"
  ];
  return [...new Set(keys.flatMap((key) => toImageList(option?.[key])).map(normalizeImageUrl).filter(isImageUrl))];
};

const fallbackRoomImage = (name, index) =>
  FALLBACK_ROOM_IMAGES[index % FALLBACK_ROOM_IMAGES.length];

const ROOM_PHOTOS = {
  bangalo: [
    "assets/gallery/2-2-scaled.webp",
    "assets/gallery/5-2-scaled.webp",
    "assets/gallery/11-2-scaled.webp",
    "assets/gallery/10-2-scaled.webp",
    "assets/gallery/13-1-scaled.webp",
    "assets/gallery/3-1-scaled.webp"
  ],
  flat: [
    "assets/gallery/Flat-4-scaled.webp",
    "assets/gallery/Flat-43-scaled.webp",
    "assets/gallery/Flat-21-scaled.webp",
    "assets/gallery/Flat-44-scaled.webp",
    "assets/gallery/Flat-23-scaled.webp",
    "assets/gallery/Flat-36-scaled.webp",
    "assets/gallery/Flat-45-scaled.webp",
    "assets/gallery/Flat-312-scaled.webp",
    "assets/gallery/Flat-313-scaled.webp",
    "assets/gallery/1-2-1-scaled.webp"
  ],
  economica: [
    "assets/gallery/Flat-21-scaled.webp",
    "assets/gallery/Flat-45-scaled.webp",
    "assets/gallery/Flat-44-scaled.webp",
    "assets/gallery/Flat-36-scaled.webp",
    "assets/gallery/Flat-312-scaled.webp",
    "assets/gallery/Flat-313-scaled.webp",
    "assets/gallery/Flat-23-scaled.webp",
    "assets/gallery/Flat-4-scaled.webp",
    "assets/gallery/1-2-1-scaled.webp"
  ]
};
const roomSlugFromName = (name) => {
  const n = String(name || "").toLowerCase();
  if (n.includes("bangal")) return "bangalo";
  if (n.includes("econômica") || n.includes("economica")) return "economica";
  if (n.includes("flat")) return "flat";
  return null;
};
const localRoomPhotos = (slug) => {
  const photos = ROOM_PHOTOS[slug];
  return Array.isArray(photos) ? photos : [];
};

const flattenRooms = (rooms) => {
  if (!rooms || Array.isArray(rooms)) return [];
  const list = [];
  for (const [roomId, plans] of Object.entries(rooms)) {
    // Mantém só tarifas públicas (descarta B2B/agência) e pega a mais barata.
    const publicPlans = Object.entries(plans)
      .map(([rid, opt]) => ({ rid, opt }))
      .filter(({ opt }) => !/b2b/i.test(opt.rateplan_name || ""));
    if (!publicPlans.length) continue;
    publicPlans.sort((a, b) => Number(a.opt.price) - Number(b.opt.price));
    const { rid, opt } = publicPlans[0];
    const fullName = opt.room_name || `Quarto ${roomId}`;
    const artaxImages = extractArtaxImages(opt);
    const localPhotos = localRoomPhotos(roomSlugFromName(fullName));
    const images = [...new Set([
      ...artaxImages,
      ...localPhotos,
      ...(!artaxImages.length && !localPhotos.length ? [fallbackRoomImage(fullName, list.length)] : [])
    ])].slice(0, 12);
    list.push({
      roomId,
      rateplanId: Number(opt.rateplan_id || rid),
      room_name: fullName.split("|")[0].trim(), // "Suíte Standard | Casal | ..." -> "Suíte Standard"
      variant: (fullName.split("|")[1] || "").trim(), // "Casal", "Triplo"...
      price: Number(opt.price),
      pricePerNight: Number(opt.price_per_nights) || null,
      image: images[0],
      images,
      imageSource: artaxImages.length ? "artax" : "fallback",
      capacity: opt.capacity || null,
      allots: opt.allots
    });
  }
  return list.sort((a, b) => a.price - b.price);
};

const renderRooms = (rooms) => {
  const list = flattenRooms(rooms);
  const container = $("#room-list");
  const resultStatus = $("[data-room-results-status]");
  const nights = state.search ? nightsBetween(state.search.arrival_date, state.search.departure_date) : 1;
  if (!list.length) {
    if (resultStatus) resultStatus.textContent = "Nenhuma acomodação encontrada para este período.";
    container.innerHTML =
      '<p class="notice info empty-state">Não há acomodações disponíveis para estas datas. Tente outras datas.</p>';
    refreshIcons();
    return;
  }
  if (resultStatus) {
    resultStatus.textContent = `${list.length} ${list.length === 1 ? "acomodação encontrada" : "acomodações encontradas"} · ${nights} ${nights === 1 ? "noite" : "noites"}`;
  }
  container.innerHTML = list
    .map((opt, i) => {
      const images = opt.images?.length ? opt.images : [opt.image].filter(Boolean);
      const variant = opt.variant ? `<span class="room-variant">${escapeHTML(opt.variant)}</span>` : "";
      const galleryStack = images.length
        ? images
            .map((src, gi) => `<img src="${escapeHTML(src)}" alt="${escapeHTML(opt.room_name)} — foto ${gi + 1}" class="${gi === 0 ? "is-active" : ""}" loading="${gi === 0 ? "eager" : "lazy"}" decoding="async" draggable="false" aria-hidden="${gi === 0 ? "false" : "true"}">`)
            .join("")
        : `<span class="room-thumb--ph"><i data-lucide="bed-double"></i></span>`;
      const galleryControls = images.length > 1
        ? `<button class="rgal-arrow rgal-prev" type="button" data-rgal-prev aria-label="Foto anterior"><i data-lucide="chevron-left" aria-hidden="true"></i></button>
           <button class="rgal-arrow rgal-next" type="button" data-rgal-next aria-label="Próxima foto"><i data-lucide="chevron-right" aria-hidden="true"></i></button>
           <span class="rgal-count" aria-live="polite"><i data-lucide="images" aria-hidden="true"></i><span data-rgal-cur>1</span>/${images.length}</span>
           <button class="rgal-open" type="button" data-gallery-open aria-label="Ver todas as ${images.length} fotos de ${escapeHTML(opt.room_name)}"><i data-lucide="maximize-2" aria-hidden="true"></i><span>Ver fotos</span></button>
           <div class="rgal-thumbs" aria-label="Escolher foto">
             ${images.slice(0, 5).map((src, gi) => `<button type="button" data-rgal-thumb="${gi}" class="${gi === 0 ? "is-active" : ""}" aria-label="Ver foto ${gi + 1}" aria-current="${gi === 0 ? "true" : "false"}"><img src="${escapeHTML(src)}" alt="" loading="lazy" decoding="async"></button>`).join("")}
           </div>`
        : "";
      return `
      <article class="room-option" data-room="${encodeRoomData(opt)}" data-i="${i}" aria-labelledby="room-title-${i}">
        <div class="room-gallery" data-rgal aria-label="Galeria de ${escapeHTML(opt.room_name)}">
          <div class="rgal-stack">${galleryStack}</div>
          ${galleryControls}
        </div>
        <div class="room-body">
          <span class="room-availability"><i data-lucide="circle-check" aria-hidden="true"></i> Disponível para suas datas</span>
          <h3 id="room-title-${i}">${escapeHTML(opt.room_name)}${variant}</h3>
          <div class="room-meta">
            <span><i data-lucide="image" aria-hidden="true"></i>${images.length} ${images.length === 1 ? "foto" : "fotos"}</span>
          </div>
        </div>
        <div class="room-side">
          <div class="price">
            <span class="price-label">Valor da estadia</span>
            ${opt.pricePerNight ? `<span class="price-night">${brl(opt.pricePerNight)} <small>/ noite</small></span>` : ""}
            <strong>${brl(opt.price)}</strong>
            <small>total · ${nights} noite(s)</small>
          </div>
          <button class="btn btn-primary room-select${isRoomSelected(opt) ? " is-selected" : ""}" type="button" aria-pressed="${isRoomSelected(opt)}" aria-label="${isRoomSelected(opt) ? "Remover" : "Selecionar"} ${escapeHTML(opt.room_name)} por ${escapeHTML(brl(opt.price))}">
            <span data-room-select-label>${isRoomSelected(opt) ? "Selecionado" : "Selecionar"}</span>
            <i data-lucide="check" aria-hidden="true"></i>
          </button>
        </div>
      </article>`;
    })
    .join("");
  refreshIcons();
  setupRoomCarousel();
  setupRoomGalleries();
  updateRoomCart();
};

/* Galeria de fotos dentro de cada card de quarto (setas + contador, sem swipe
   pra não conflitar com o carrossel horizontal de quartos no mobile). */
const setupRoomGalleries = () => {
  $$("[data-rgal]").forEach((gal) => {
    const imgs = $$(".rgal-stack img", gal);
    const cur = $("[data-rgal-cur]", gal);
    const thumbs = $$("[data-rgal-thumb]", gal);
    let i = 0;
    const show = (n) => {
      i = (n + imgs.length) % imgs.length;
      imgs.forEach((im, k) => {
        im.classList.toggle("is-active", k === i);
        im.setAttribute("aria-hidden", String(k !== i));
      });
      thumbs.forEach((thumb, k) => {
        thumb.classList.toggle("is-active", k === i);
        thumb.setAttribute("aria-current", String(k === i));
      });
      if (cur) cur.textContent = String(i + 1);
    };
    if (imgs.length <= 1) return;
    $("[data-rgal-prev]", gal)?.addEventListener("click", (e) => { e.stopPropagation(); show(i - 1); });
    $("[data-rgal-next]", gal)?.addEventListener("click", (e) => { e.stopPropagation(); show(i + 1); });
    thumbs.forEach((thumb) => thumb.addEventListener("click", (e) => {
      e.stopPropagation();
      show(Number(thumb.dataset.rgalThumb));
    }));
    const openGallery = (trigger) => {
      const card = gal.closest("[data-room]");
      if (!card) return;
      const room = decodeRoomData(card.dataset.room);
      openRoomGallery(room.images || [room.image].filter(Boolean), room.room_name, i, trigger);
    };
    $("[data-gallery-open]", gal)?.addEventListener("click", (e) => {
      e.stopPropagation();
      openGallery(e.currentTarget);
    });
    $(".rgal-stack", gal)?.addEventListener("click", (e) => {
      e.stopPropagation();
      openGallery($("[data-gallery-open]", gal) || gal);
    });
  });
};

/* Galeria ampliada: mantém o usuário no fluxo e oferece navegação por teclado. */
const roomGalleryState = { images: [], index: 0, name: "", trigger: null };

const renderRoomGallery = () => {
  const modal = $("[data-gallery-modal]");
  const image = $("[data-gallery-image]", modal);
  const counter = $("[data-gallery-counter]", modal);
  const title = $("[data-gallery-title]", modal);
  const thumbs = $("[data-gallery-thumbs]", modal);
  const total = roomGalleryState.images.length;
  if (!modal || !image || !total) return;

  roomGalleryState.index = (roomGalleryState.index + total) % total;
  const current = roomGalleryState.images[roomGalleryState.index];
  image.src = current;
  image.alt = `${roomGalleryState.name} — foto ${roomGalleryState.index + 1} de ${total}`;
  if (title) title.textContent = roomGalleryState.name;
  if (counter) counter.textContent = `${roomGalleryState.index + 1} de ${total}`;
  $$('[data-gallery-thumb]', thumbs).forEach((button, index) => {
    const active = index === roomGalleryState.index;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-current", String(active));
    if (active) button.scrollIntoView({ block: "nearest", inline: "center" });
  });
  $$('[data-gallery-prev], [data-gallery-next]', modal).forEach((button) => {
    button.disabled = total <= 1;
  });
};

const moveRoomGallery = (direction) => {
  roomGalleryState.index += direction;
  renderRoomGallery();
};

const openRoomGallery = (images, name, initialIndex = 0, trigger = null) => {
  const modal = $("[data-gallery-modal]");
  const list = [...new Set((images || []).map(normalizeImageUrl).filter(isImageUrl))];
  if (!modal || !list.length) return;
  roomGalleryState.images = list;
  roomGalleryState.index = Math.max(0, Math.min(list.length - 1, Number(initialIndex) || 0));
  roomGalleryState.name = name || "Acomodação";
  roomGalleryState.trigger = trigger instanceof HTMLElement ? trigger : document.activeElement;
  const thumbs = $("[data-gallery-thumbs]", modal);
  if (thumbs) {
    thumbs.innerHTML = list.map((src, index) => `
      <button type="button" data-gallery-thumb="${index}" aria-label="Ver foto ${index + 1}" aria-current="${index === roomGalleryState.index ? "true" : "false"}" class="${index === roomGalleryState.index ? "is-active" : ""}">
        <img src="${escapeHTML(src)}" alt="" loading="lazy" decoding="async">
      </button>`).join("");
  }
  modal.hidden = false;
  document.body.classList.add("modal-open", "gallery-open");
  renderRoomGallery();
  refreshIcons();
  $(".gallery-close", modal)?.focus();
};

const closeRoomGallery = () => {
  const modal = $("[data-gallery-modal]");
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  document.body.classList.remove("gallery-open");
  if ($("[data-noavail]")?.hidden !== false) document.body.classList.remove("modal-open");
  const trigger = roomGalleryState.trigger;
  roomGalleryState.images = [];
  roomGalleryState.trigger = null;
  if (trigger instanceof HTMLElement) trigger.focus();
};

/* Carrossel horizontal dos quartos (tablet/mobile) — não rola a página. */
const setupRoomCarousel = () => {
  const list = $("#room-list");
  const nav = $("[data-room-nav]");
  if (!list || !nav) return;
  const cards = $$(".room-option", list);
  const dotsWrap = $("[data-rn-dots]", nav);
  const prev = $("[data-rn-prev]", nav);
  const next = $("[data-rn-next]", nav);

  nav.classList.toggle("is-hidden", cards.length <= 1);
  dotsWrap.innerHTML = cards
    .map((_, i) => `<button type="button" class="rcn-dot${i === 0 ? " is-active" : ""}" data-rn-dot="${i}" aria-label="Quarto ${i + 1}"></button>`)
    .join("");
  const dots = $$("[data-rn-dot]", nav);
  let idx = 0;

  const setActive = (i) => {
    idx = Math.max(0, Math.min(cards.length - 1, i));
    dots.forEach((d, di) => {
      d.classList.toggle("is-active", di === idx);
      d.setAttribute("aria-current", di === idx ? "true" : "false");
    });
    prev.disabled = idx <= 0;
    next.disabled = idx >= cards.length - 1;
  };
  const go = (i) => {
    setActive(i);
    cards[idx]?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  };

  prev.onclick = () => go(idx - 1);
  next.onclick = () => go(idx + 1);
  dots.forEach((d, i) => (d.onclick = () => go(i)));

  let raf;
  list.onscroll = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const center = list.scrollLeft + list.clientWidth / 2;
      let best = 0, bestDist = Infinity;
      cards.forEach((c, i) => {
        const cc = c.offsetLeft + c.offsetWidth / 2;
        const d = Math.abs(cc - center);
        if (d < bestDist) { bestDist = d; best = i; }
      });
      setActive(best);
    });
  };

  setActive(0);
};

const buildInstallments = (price) => {
  const sel = $("#c-inst");
  if (!sel) return;
  sel.innerHTML = "";
  for (let n = 1; n <= INSTALLMENTS_MAX; n += 1) {
    const each = price / n;
    const o = document.createElement("option");
    o.value = String(n);
    o.textContent = n === 1 ? `À vista — ${brl(price)}` : `${n}x de ${brl(each)} sem juros`;
    sel.appendChild(o);
  }
};

/* Antes: clicar num card selecionava e já pulava pra etapa 3. Com seleção
   múltipla o clique só marca/desmarca — quem avança é o botão "Continuar" da
   barra do carrinho (ver confirmRoomSelection). */
const toggleRoomSelection = (opt) => {
  const idx = state.selectedRooms.findIndex((r) => sameRoom(r, opt));
  if (idx >= 0) state.selectedRooms.splice(idx, 1);
  else state.selectedRooms.push(opt);
  syncRoomCards();
  updateRoomCart();
  updateSummary();
  updateReview();
  persistState();
};

/* Reflete o carrinho nos cards já renderizados, sem reconstruir a lista — assim
   a galeria de fotos de cada card não perde o slide/scroll em que estava. */
const syncRoomCards = () => {
  $$("#room-list [data-room]").forEach((card) => {
    let opt;
    try { opt = decodeRoomData(card.dataset.room); } catch (_) { return; }
    const on = isRoomSelected(opt);
    card.classList.toggle("is-selected", on);
    const btn = $(".room-select", card);
    if (!btn) return;
    btn.classList.toggle("is-selected", on);
    const text = $("[data-room-select-label]", btn);
    if (text) text.textContent = on ? "Selecionado" : "Selecionar";
    btn.setAttribute("aria-pressed", String(on));
    btn.setAttribute(
      "aria-label",
      `${on ? "Remover" : "Selecionar"} ${opt.room_name} por ${brl(opt.price)}`
    );
  });
  refreshIcons();
};

const updateRoomCart = () => {
  const bar = $("[data-room-cart]");
  if (!bar) return;
  const count = cartCount();
  bar.classList.toggle("is-hidden", count === 0);
  const info = $("[data-room-cart-count]", bar);
  if (info) {
    info.textContent = count === 1
      ? "1 acomodação selecionada"
      : `${count} acomodações selecionadas`;
  }
  const total = $("[data-room-cart-total]", bar);
  if (total) total.textContent = brl(cartTotal());
  const btn = $("[data-rooms-continue]", bar);
  if (btn) btn.disabled = count === 0;
};

const confirmRoomSelection = () => {
  if (!cartCount()) {
    return showNotice("Selecione ao menos uma acomodação para continuar.", "info");
  }
  buildInstallments(cartTotal());
  goToStep(3);
  goToPayStep("guest"); // dados primeiro; forma de pagamento vai na tela final
  persistState();
};

/* ---------- máscaras dos campos ---------- */
const maskCardNumber = (el) => {
  const v = el.value.replace(/\D/g, "").slice(0, 19);
  el.value = v.replace(/(.{4})/g, "$1 ").trim();
};
const maskExpiry = (el) => {
  let v = el.value.replace(/\D/g, "").slice(0, 4);
  if (v.length >= 3) v = `${v.slice(0, 2)}/${v.slice(2)}`;
  el.value = v;
};
const onlyDigits = (el) => { el.value = el.value.replace(/\D/g, ""); };

// Telefone com DDD: aceita fixo de 10 e celular de 11 dígitos.
const maskPhone = (el) => {
  let v = el.value.replace(/\D/g, "").slice(0, 11);
  if (v.length > 10) v = v.replace(/^(\d{2})(\d{5})(\d{0,4}).*/, "($1) $2-$3");
  else if (v.length > 6) v = v.replace(/^(\d{2})(\d{4})(\d{0,4}).*/, "($1) $2-$3");
  else if (v.length > 2) v = v.replace(/^(\d{2})(\d{0,5})/, "($1) $2");
  else if (v.length > 0) v = v.replace(/^(\d{0,2})/, "($1");
  el.value = v;
};

// CPF: 000.000.000-00
const maskCPF = (el) => {
  el.value = el.value
    .replace(/\D/g, "")
    .slice(0, 11)
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d{1,2})$/, "$1-$2");
};

// Documento: CPF formatado, passaporte alfanumérico, RG/demais só dígitos.
const maskDocument = (el) => {
  const type = $("#g-doctype")?.value;
  if (type === "cpf") return maskCPF(el);
  if (type === "passport") {
    el.value = el.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 9);
    return;
  }
  el.value = el.value.replace(/\D/g, "").slice(0, 14);
};

// O placeholder repete o tipo escolhido, para o hóspede não perder de vista
// qual documento está digitando enquanto olha só para o campo.
const DOC_PLACEHOLDER = { cpf: "CPF · 000.000.000-00", passport: "Passaporte · AB123456" };
const DOC_EMPTY_PLACEHOLDER = "Selecione o documento acima";

const syncDocumentInputMode = () => {
  const input = $("#g-doc");
  if (!input) return;
  const type = $("#g-doctype")?.value || "";
  // Sem tipo escolhido o campo fica bloqueado — digitar antes de escolher só
  // levaria a apagar tudo depois, já que os formatos são incompatíveis.
  if (!type) {
    input.value = "";
    input.disabled = true;
    input.placeholder = DOC_EMPTY_PLACEHOLDER;
    return;
  }
  const passport = type === "passport";
  input.disabled = false;
  input.inputMode = passport ? "text" : "numeric";
  input.autocapitalize = passport ? "characters" : "off";
  input.placeholder = DOC_PLACEHOLDER[type] || "";
  maskDocument(input);
};

/* Marca o card do tipo escolhido e reaplica a máscara. O <input> oculto
   #g-doctype segue sendo a fonte da verdade — todo o resto do código (payload,
   persistência, restauração) continua lendo dele, sem saber dos cards. */
const setDocType = (type) => {
  const hidden = $("#g-doctype");
  if (!hidden) return;
  const changed = hidden.value !== type;
  hidden.value = type;
  $$("[data-doctype]").forEach((card) => {
    const on = card.dataset.doctype === type;
    card.classList.toggle("is-active", on);
    card.setAttribute("aria-checked", String(on));
  });
  // Trocar de tipo invalida o que já estava digitado (formatos incompatíveis).
  if (changed) {
    const input = $("#g-doc");
    if (input) input.value = "";
  }
  syncDocumentInputMode();
  persistState();
};

/* CPF: 11 dígitos + dígitos verificadores. Evita que um número digitado errado
   só apareça como problema lá na frente, no PMS. */
const cpfValid = (raw) => {
  const d = String(raw).replace(/\D/g, "");
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const check = (len) => {
    let sum = 0;
    for (let i = 0; i < len; i += 1) sum += Number(d[i]) * (len + 1 - i);
    const mod = (sum * 10) % 11;
    return (mod === 10 ? 0 : mod) === Number(d[len]);
  };
  return check(9) && check(10);
};

/* ---------- etapa 3: pagamento (sub-etapas: forma -> dados -> pagar) ---------- */
let payMethod = "pix";
let pixPoll = null;
let pixTick = null;       // contador regressivo (1s)
let currentPix = null;    // { tid, expiresAt, qrCode, qrImage } da cobrança ativa

const guardActivePix = () => {
  if (!currentPix) return false;
  showNotice("Há um PIX ativo aguardando pagamento. Conclua o pagamento ou aguarde a expiração para alterar a reserva.", "info");
  return true;
};

const PAYSTEPS = ["guest", "pay"];
let payStep = "guest";

const payStepTitle = (name) =>
  name === "guest" ? "Dados do hóspede"
    : name === "pay" ? (payMethod === "pix" ? "Pague com PIX" : "Dados do cartão")
      : "Dados do hóspede";

const goToPayStep = (name) => {
  if (name !== "pay" && guardActivePix()) return;
  payStep = name;
  $$("[data-paystep]").forEach((p) => p.classList.toggle("is-hidden", p.dataset.paystep !== name));
  const cur = PAYSTEPS.indexOf(name);
  $$("[data-paystep-dot]").forEach((d) => {
    const i = PAYSTEPS.indexOf(d.dataset.paystepDot);
    d.classList.toggle("is-active", i === cur);
    d.classList.toggle("is-done", i < cur);
    d.setAttribute("aria-current", i === cur ? "step" : "false");
  });
  const title = $("[data-paystep-title]");
  const intro = $("[data-paystep-intro]");
  if (title) title.textContent = payStepTitle(name);
  if (intro) {
    intro.textContent = name === "guest"
      ? "Preencha seus dados."
      : name === "pay"
        ? (payMethod === "pix" ? "Finalize com PIX." : "Informe os dados do cartão.")
        : "Escolha PIX ou cartão.";
  }
  if (name === "pay") setPayMethod(payMethod); // garante painel/campos corretos ao chegar
  else ["#c-number", "#c-name", "#c-exp", "#c-cvv", "#c-inst"].forEach((sel) => {
    const field = $(sel);
    if (field) field.disabled = true;
  });
  refreshIcons();
  focusHeading(title);
  persistState();
  if (isEmbeddedCheckout()) {
    const topic = name === "guest"
      ? "payment:guest"
      : name === "pay"
        ? `payment:pay:${payMethod}`
        : "payment:guest";
    notifyEmbedView(3, topic);
  } else {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
};

/* Dados do hóspede em 3 mini-etapas: nome -> contato -> documento */
const setPayMethod = (method) => {
  if (method !== "pix" && guardActivePix()) return;
  payMethod = method;
  $$("[data-pay-method]").forEach((t) => {
    const active = t.dataset.payMethod === method;
    t.classList.toggle("is-active", active);
    t.setAttribute("aria-pressed", String(active));
  });
  $$("[data-pane]").forEach((p) => p.classList.toggle("is-hidden", p.dataset.pane !== method));
  // Só valida cartão quando o respectivo painel de pagamento está visível.
  ["#c-number", "#c-name", "#c-exp", "#c-cvv", "#c-inst"].forEach((sel) => {
    const el = $(sel);
    if (el) el.disabled = method !== "card" || payStep !== "pay";
  });
  const label = $("#pay-btn .label");
  if (label) label.textContent = method === "pix" ? "Gerar PIX" : "Pagar e reservar";
  const title = $("[data-paystep-title]");
  if (title && payStep === "pay") title.textContent = payStepTitle("pay");
  const intro = $("[data-paystep-intro]");
  if (intro && payStep === "pay") intro.textContent = method === "pix" ? "Finalize com PIX." : "Informe os dados do cartão.";
  persistState();
  if (Number(document.body.dataset.step) === 3) {
    notifyEmbedView(3, payStep === "pay" ? `payment:pay:${method}` : `payment:${payStep}`);
  }
};

/* ---------- bandeira do cartão + prévia ao vivo ---------- */
const CARD_BRANDS = [
  ["visa", /^4/, "Visa"],
  ["mastercard", /^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/, "Mastercard"],
  ["amex", /^3[47]/, "Amex"],
  ["elo", /^(4011|4312|4389|4514|4576|5041|5066|5067|509\d|6277|6362|6363|650|6516|6550)/, "Elo"],
  ["hipercard", /^(606282|3841)/, "Hipercard"],
  ["diners", /^(36|38|30[0-5])/, "Diners"],
  ["discover", /^(6011|64[4-9]|65)/, "Discover"]
];
const detectBrand = (digits) => {
  for (const [key, re, label] of CARD_BRANDS) if (re.test(digits)) return { key, label };
  return { key: "", label: "" };
};
const previewNumber = (digits) =>
  ((digits || "") + "•".repeat(16)).slice(0, 16).replace(/(.{4})/g, "$1 ").trim();

const updateCardPreview = () => {
  const prev = $("[data-card-preview]");
  if (!prev) return;
  const digits = ($("#c-number")?.value || "").replace(/\D/g, "");
  const { key, label } = detectBrand(digits);
  prev.dataset.brand = key;
  $("[data-cardp-number]").textContent = previewNumber(digits);
  $("[data-cardp-name]").textContent = ($("#c-name")?.value || "").trim().toUpperCase() || "NOME COMPLETO";
  $("[data-cardp-exp]").textContent = $("#c-exp")?.value || "MM/AA";
  $("[data-cardp-brand]").textContent = label;
};

const baseReservationPayload = () => ({
  arrival_date: state.search.arrival_date,
  departure_date: state.search.departure_date,
  adults: state.search.adults,
  kids: state.search.kids,
  ages: state.search.ages,
  rooms: state.selectedRooms.map((r) => ({ room_id: r.roomId, rateplan_id: r.rateplanId })),
  ask_si: getAskSi() || undefined,
  guest: {
    first_name: $("#g-first").value.trim(),
    last_name: $("#g-last").value.trim(),
    phone: $("#g-phone").value,
    email: $("#g-email").value.trim(),
    document: $("#g-doc").value,
    document_type: $("#g-doctype").value || undefined,
    type: "guest"
  }
});

const guestValid = () => {
  if (!$("#g-first").value.trim()) return invalidateField($("#g-first"), "Informe o nome do hóspede.");
  if ($("#g-phone").value.replace(/\D/g, "").length < 10) return invalidateField($("#g-phone"), "Informe um telefone válido com DDD.");
  // Documento passou a ser obrigatório.
  const docType = $("#g-doctype")?.value || "";
  const docValue = ($("#g-doc")?.value || "").trim();
  if (!docType) return invalidateField($("#g-doc"), "Escolha o tipo de documento: CPF ou Passaporte.");
  if (!docValue) return invalidateField($("#g-doc"), "Informe o número do documento.");
  if (docType === "cpf" && !cpfValid(docValue)) {
    return invalidateField($("#g-doc"), "CPF inválido. Confira os números.");
  }
  if (docType === "passport" && docValue.replace(/[^A-Za-z0-9]/g, "").length < 6) {
    return invalidateField($("#g-doc"), "Passaporte inválido. Informe ao menos 6 caracteres.");
  }
  return true;
};

const passesLuhn = (digits) => {
  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum > 0 && sum % 10 === 0;
};

const validatedCard = () => {
  const fail = (field, message) => {
    invalidateField(field, message);
    return null;
  };
  const numberField = $("#c-number");
  const holderField = $("#c-name");
  const expiryField = $("#c-exp");
  const cvvField = $("#c-cvv");
  const number = numberField.value.replace(/\D/g, "");
  const holderName = holderField.value.trim();
  const expiryMatch = expiryField.value.match(/^(\d{2})\/(\d{2})$/);
  const securityCode = cvvField.value.replace(/\D/g, "");

  if (number.length < 13 || number.length > 19 || !passesLuhn(number)) {
    return fail(numberField, "Confira o número do cartão.");
  }
  if (holderName.length < 2) return fail(holderField, "Informe o nome impresso no cartão.");
  if (!expiryMatch) return fail(expiryField, "Informe a validade no formato MM/AA.");

  const expirationMonth = Number(expiryMatch[1]);
  const expirationYear = 2000 + Number(expiryMatch[2]);
  const expiresAt = new Date(expirationYear, expirationMonth, 0, 23, 59, 59);
  if (expirationMonth < 1 || expirationMonth > 12 || expiresAt < new Date()) {
    return fail(expiryField, "O cartão está vencido ou a validade é inválida.");
  }
  if (securityCode.length < 3 || securityCode.length > 4) {
    return fail(cvvField, "Confira o código de segurança (CVV).");
  }

  return { number, holderName, expirationMonth, expirationYear, securityCode };
};

const submitCheckout = (event) => {
  event.preventDefault();
  clearNotice();
  if (!cartCount() || !state.search) return goToStep(1);
  // Enter/submit avança as sub-etapas; só paga na última.
  if (payStep === "guest") { if (guestValid()) goToPayStep("pay"); return; }
  if (!guestValid()) return goToPayStep("guest");
  if (payMethod === "pix") submitPix();
  else submitCard();
};

const submitCard = async () => {
  const card = validatedCard();
  if (!card) return;
  const payload = {
    ...baseReservationPayload(),
    installments: Number($("#c-inst").value) || 1,
    card
  };
  const btn = $("#pay-btn");
  btn.disabled = true;
  btn.querySelector(".label").innerHTML = '<span class="spinner"></span> Processando...';
  try {
    const res = await fetch(`${API_BASE}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await readJSON(res);
    if (!res.ok) throw new Error(data.error || "Não foi possível concluir o pagamento.");
    if (data.payment?.captured === false) {
      throw new Error("A reserva foi criada, mas o pagamento ainda precisa de confirmação. Não tente novamente; fale com a recepção e informe o número da reserva.");
    }
    renderSuccess(data);
  } catch (err) {
    showNotice(err.message);
    btn.disabled = false;
    btn.querySelector(".label").textContent = "Pagar e reservar";
  }
};

const submitPix = async () => {
  const btn = $("#pay-btn");
  btn.disabled = true;
  btn.querySelector(".label").innerHTML = '<span class="spinner"></span> Gerando PIX...';
  try {
    const res = await fetch(`${API_BASE}/pix/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseReservationPayload())
    });
    const data = await readJSON(res);
    if (!res.ok) throw new Error(data.error || "Não foi possível gerar o PIX.");
    showPix(data);
  } catch (err) {
    showNotice(err.message);
    btn.disabled = false;
    btn.querySelector(".label").textContent = "Gerar PIX";
  }
};

// Renderiza o QR + copia-e-cola a partir de um objeto pix.
const renderPixView = (pix) => {
  const result = $("[data-pix-result]");
  const img = $("[data-pix-img]");
  const code = $("[data-pix-code]");
  if (pix.qrImage) {
    img.src = pix.qrImage.startsWith("data:") || /^https?:/.test(pix.qrImage)
      ? pix.qrImage
      : `data:image/png;base64,${pix.qrImage}`;
  } else if (pix.qrCode) {
    img.src = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(pix.qrCode)}`;
  }
  if (code) code.value = pix.qrCode || "";
  result.classList.remove("is-hidden");
  const st = $("[data-pix-status]");
  if (st) st.innerHTML = '<span class="spinner spinner-dark"></span> Aguardando pagamento…';
  const btn = $("#pay-btn");
  if (btn) {
    btn.disabled = true;
    btn.querySelector(".label").innerHTML = '<span class="spinner"></span> Aguardando pagamento…';
  }
  notifyEmbedView(3, "payment:pay:pix-result");
};

const showPix = (data) => {
  const ttlSec = Number(data.expiresInSec) || 15 * 60;
  currentPix = {
    tid: data.tid,
    expiresAt: Date.now() + ttlSec * 1000,
    qrCode: data.qrCode || "",
    qrImage: data.qrImage || ""
  };
  renderPixView(currentPix);
  startPixCountdown(currentPix.expiresAt);
  startPixPolling(currentPix.tid, currentPix.expiresAt);
  persistState();
};

// Restaura uma cobrança PIX ativa depois de recarregar a página.
const restorePix = (pix) => {
  if (!pix || !pix.tid || !(pix.expiresAt > Date.now())) return;
  currentPix = pix;
  renderPixView(currentPix);
  startPixCountdown(currentPix.expiresAt);
  startPixPolling(currentPix.tid, currentPix.expiresAt);
};

const stopPixPolling = () => {
  if (pixPoll) clearInterval(pixPoll);
  if (pixTick) clearInterval(pixTick);
  pixPoll = pixTick = null;
};

const startPixCountdown = (expiresAt) => {
  if (pixTick) clearInterval(pixTick);
  const el = $("[data-pix-timer]");
  const tick = () => {
    const ms = expiresAt - Date.now();
    if (ms <= 0) { clearInterval(pixTick); pixTick = null; if (el) el.textContent = "Expirado"; pixExpired(); return; }
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    if (el) el.textContent = `Expira em ${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };
  tick();
  pixTick = setInterval(tick, 1000);
};

const startPixPolling = (tid, expiresAt) => {
  if (pixPoll) clearInterval(pixPoll);
  const check = async () => {
    if (expiresAt && Date.now() >= expiresAt) { stopPixPolling(); pixExpired(); return; }
    try {
      const res = await fetch(`${API_BASE}/pix/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tid })
      });
      const data = await readJSON(res);
      if (data.status === "paid") { stopPixPolling(); renderSuccess(data); }
      else if (data.status === "expired" || data.status === "canceled") { stopPixPolling(); pixExpired(); }
    } catch (_) { /* mantém tentando */ }
  };
  pixPoll = setInterval(check, 4000);
  check();
};

const pixExpired = () => {
  stopPixPolling();
  currentPix = null;
  const tm = $("[data-pix-timer]");
  if (tm) tm.textContent = "";
  const result = $("[data-pix-result]");
  if (result) result.classList.add("is-hidden");
  const btn = $("#pay-btn");
  if (btn) {
    btn.disabled = false;
    btn.querySelector(".label").textContent = "Gerar novo PIX";
  }
  showNotice("O PIX expirou. Gere um novo código para continuar.", "info");
  persistState();
  refreshIcons();
  notifyEmbedView(3, "payment:pay:pix");
};

/* Avisa a home da compra concluída, para o Pixel da Meta disparar o `Purchase`.
   O evento tem que sair da home, não daqui: o checkout roda dentro de um iframe,
   e um pixel disparando lá dentro contaria como outra sessão, estragando a
   atribuição. Reaproveita o mesmo canal já usado para altura e etapa. */
/* Correspondência avançada da Meta: e-mail e telefone do hóspede. O Pixel faz
   o hash SHA-256 no navegador antes de enviar — os valores em texto nunca saem
   daqui. Só vão no momento da compra, e apenas os dois campos que a Meta usa
   para casar a conversão. O telefone segue no padrão internacional (55 + DDD). */
const advancedMatching = () => {
  const out = {};
  const email = ($("#g-email")?.value || "").trim().toLowerCase();
  if (email.includes("@")) out.em = email;
  const digits = ($("#g-phone")?.value || "").replace(/\D/g, "");
  if (digits.length >= 10) out.ph = digits.startsWith("55") ? digits : `55${digits}`;
  return out;
};

const notifyEmbedPurchase = (data) => {
  if (!isEmbeddedCheckout() || !data?.booking_id) return;
  const rooms = (Array.isArray(data.rooms) ? data.rooms : [data.room]).filter(Boolean);
  parent.postMessage({
    cz: "purchase",
    bookingId: String(data.booking_id),
    value: Number(data.payment?.amount ?? cartTotal()) || 0,
    contents: (rooms.length ? rooms : state.selectedRooms).map((r) => ({
      id: String(r.id ?? r.roomId ?? ""),
      quantity: 1,
      item_price: Number(r.price ?? 0)
    })),
    match: advancedMatching()
  }, embedTargetOrigin);
};

const renderSuccess = (data) => {
  stopPixPolling();
  currentPix = null;
  notifyEmbedPurchase(data); // antes do clearState(), que zera o carrinho
  clearState();
  $("#booking-id").textContent = `Reserva nº ${data.booking_id}`;

  // Aviso de e-mail de confirmação
  const email = (data.guest_email || $("#g-email")?.value || "").trim();
  const emailEl = $("[data-success-email]");
  if (emailEl) {
    emailEl.innerHTML = email
      ? `<i data-lucide="mail-check" aria-hidden="true"></i> Enviamos a confirmação para <strong>${escapeHTML(email)}</strong>.`
      : `<i data-lucide="bookmark-check" aria-hidden="true"></i> Guarde o número da reserva para consultar com a recepção.`;
  }

  const p = data.payment || {};
  const methodLabel = p.method === "pix" ? "PIX" : `Cartão${p.installments ? ` · ${p.installments}x` : ""}`;
  const bookedRoomNames = (Array.isArray(data.rooms) ? data.rooms : [data.room])
    .filter(Boolean)
    .map((room) => room.name)
    .filter(Boolean)
    .join(", ") || "—";
  $("#success-details").innerHTML = `
    <div class="summary-row"><span>Acomodação</span><span>${escapeHTML(bookedRoomNames)}</span></div>
    <div class="summary-row"><span>Check-in</span><span>${fmtDate(state.search.arrival_date)}</span></div>
    <div class="summary-row"><span>Check-out</span><span>${fmtDate(state.search.departure_date)}</span></div>
    <div class="summary-row"><span>Pagamento</span><span>${methodLabel}</span></div>
    <div class="summary-total"><span>Pago</span><strong>${brl(p.amount || cartTotal())}</strong></div>`;
  goToStep(4);
  refreshIcons();
};

/* ---------- persistência (sessionStorage): retoma de onde parou ----------
   sessionStorage e não localStorage de propósito: o estado morre quando a aba
   fecha, então quem sai do site e volta depois começa do início. Antes, com
   localStorage, a etapa ficava gravada por 2h mesmo fechando o navegador.
   Recarregar a página sem fechar a aba continua preservando o progresso. */
const STORAGE_KEY = "vz_checkout_v1";
const STORAGE_TTL = 2 * 60 * 60 * 1000; // 2h

function persistState() {
  try {
    const snap = {
      v: 1,
      ts: Date.now(),
      step: Number(document.body.dataset.step) || 1,
      payStep,
      payMethod,
      search: state.search,
      selectedRooms: state.selectedRooms,
      installments: Number($("#c-inst")?.value) || 1,
      guest: {
        first: $("#g-first")?.value || "",
        last: $("#g-last")?.value || "",
        phone: $("#g-phone")?.value || "",
        email: $("#g-email")?.value || "",
        doctype: $("#g-doctype")?.value || "",
        doc: $("#g-doc")?.value || ""
      },
      pix: currentPix // dados do cartão NUNCA são salvos
    };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
  } catch (_) { /* sessionStorage indisponível */ }
}

const loadState = () => {
  try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null"); } catch { return null; }
};
const clearState = () => {
  try { sessionStorage.removeItem(STORAGE_KEY); } catch (_) {}
};

// Limpeza única: quem visitou o site antes desta mudança tem a chave gravada no
// localStorage, que ninguém mais lê. Sem isso ela ficaria presa no navegador do
// hóspede para sempre.
try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}

const hasExplicitSearchQuery = () => {
  const params = new URLSearchParams(location.search);
  const directKeys = new Set(["arrival_date", "departure_date", "entrada", "saida", "adults", "hospedes", "kids", "children"]);
  return [...params.keys()].some((key) => directKeys.has(key) || /^ages(?:\[\d*\])?$/.test(key));
};

const restoreSearchInputs = (search) => {
  if (!search) return;
  const set = (sel, value) => { const el = $(sel); if (el) el.value = value; };
  set("#arrival", search.arrival_date || "");
  set("#departure", search.departure_date || "");
  set("#adults", String(Math.min(9, Math.max(1, Number(search.adults) || 2))));
  set("#kids", String(Math.min(6, Math.max(0, Number(search.kids) || 0))));
  buildAgesInputs();
  (search.ages || []).forEach((age, index) => {
    const input = $$("#ages-inputs [data-age]")[index];
    if (input) input.value = String(Math.max(0, Math.min(5, Number(age) || 0)));
  });
};

// Preenche os campos antes de iniciar o calendário, sem superar datas novas da URL.
const primeStoredSearch = () => {
  const saved = loadState();
  if (!saved?.search || saved.v !== 1 || hasExplicitSearchQuery()) return;
  if (Date.now() - saved.ts > STORAGE_TTL) { clearState(); return; }
  restoreSearchInputs(saved.search);
};

const restoreGuest = (g) => {
  if (!g) return;
  const set = (sel, v) => { const el = $(sel); if (el) el.value = v || ""; };
  set("#g-first", g.first); set("#g-last", g.last); set("#g-phone", g.phone);
  set("#g-email", g.email);
  // Só CPF e Passaporte são oferecidos. Sessões antigas com "rg" (ou sem tipo)
  // voltam sem escolha, com o campo bloqueado, em vez de assumir um tipo errado.
  const savedType = g.doctype === "cpf" || g.doctype === "passport" ? g.doctype : "";
  $$("[data-doctype]").forEach((card) => {
    const on = savedType && card.dataset.doctype === savedType;
    card.classList.toggle("is-active", Boolean(on));
    card.setAttribute("aria-checked", String(Boolean(on)));
  });
  set("#g-doctype", savedType);
  set("#g-doc", savedType ? g.doc : "");
  syncDocumentInputMode();
};

const restoreState = async () => {
  const saved = loadState();
  if (!saved || saved.v !== 1 || !saved.search) return false;
  if (Date.now() - saved.ts > STORAGE_TTL) { clearState(); return false; }
  if (hasExplicitSearchQuery()) { clearState(); return false; }

  // restaura a busca (inputs) e os hóspedes
  state.search = saved.search;
  restoreSearchInputs(saved.search);
  restoreGuest(saved.guest);
  updateSummary();

  // Uma tarifa salva nunca é reutilizada sem nova consulta de disponibilidade.
  // Compatível com sessões gravadas antes da seleção múltipla, que salvavam um
  // único objeto em `selection` em vez do array `selectedRooms`.
  const savedRooms = Array.isArray(saved.selectedRooms)
    ? saved.selectedRooms
    : (saved.selection ? [saved.selection] : []);

  if (savedRooms.length) {
    try {
      const count = await runAvailability(saved.search);
      if (!count) {
        state.selectedRooms = [];
        updateRoomCart();
        updateSummary();
        persistState();
        goToStep(1);
        showNoAvailability();
        return true;
      }
    } catch (_) {
      state.selectedRooms = [];
      updateRoomCart();
      updateSummary();
      goToStep(1);
      showNotice("Não foi possível revalidar a tarifa salva. Faça uma nova busca para continuar.", "info");
      return true;
    }

    // Revalida item a item: só sobrevive o que ainda existe na disponibilidade
    // recém-consultada. Se algum caiu, o hóspede volta pra etapa 2 e refaz a
    // escolha — nunca seguimos com um carrinho parcialmente inválido.
    const fresh = $$(".room-option").map((card) => decodeRoomData(card.dataset.room));
    const revalidated = savedRooms
      .map((sel) => fresh.find((room) => sameRoom(room, sel)))
      .filter(Boolean);

    if (revalidated.length !== savedRooms.length) {
      state.selectedRooms = revalidated;
      syncRoomCards();
      updateRoomCart();
      updateSummary();
      persistState();
      goToStep(2);
      showNotice(
        revalidated.length
          ? "Parte das acomodações escolhidas mudou de tarifa ou não está mais disponível. Confira a seleção para continuar."
          : "A tarifa escolhida mudou. Selecione novamente uma acomodação para continuar.",
        "info"
      );
      return true;
    }

    state.selectedRooms = revalidated;
    syncRoomCards();
    updateRoomCart();
    updateSummary();
    updateReview();
    buildInstallments(cartTotal());
    if (saved.installments && saved.installments <= INSTALLMENTS_MAX) {
      $("#c-inst").value = String(saved.installments);
    }
    goToStep(3);
    setPayMethod(saved.payMethod || "pix");
    goToPayStep(saved.payStep === "pay" ? "pay" : "guest");
    if (saved.pix && saved.pix.expiresAt > Date.now()) restorePix(saved.pix);
    return true;
  }

  // estava só na lista de quartos
  if (saved.step === 2) {
    try {
      if (await runAvailability(saved.search)) goToStep(2);
      else { goToStep(1); showNoAvailability(); }
    } catch (_) {
      goToStep(1);
      showNotice("Não foi possível atualizar a disponibilidade. Tente novamente.", "info");
    }
    return true;
  }
  return false;
};

/* ---------- steppers (+/-) estilo motor de reservas Artax ---------- */
const initSteppers = () => {
  $$(".stepper").forEach((stepper) => {
    const input = stepper.querySelector("input");
    const min = Number(stepper.dataset.min || 0);
    const max = Number(stepper.dataset.max || 99);
    const set = (val) => {
      const next = Math.min(max, Math.max(min, val));
      input.value = String(next);
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    stepper.querySelector("[data-dec]").addEventListener("click", () => set(Number(input.value) - 1));
    stepper.querySelector("[data-inc]").addEventListener("click", () => set(Number(input.value) + 1));
  });
};

/* ---------- calendário de intervalo (check-in -> check-out) ---------- */
const initCalendar = () => {
  const root = $("[data-cal]");
  if (!root) return;
  const grid = $("[data-cal-grid]", root);
  const title = $("[data-cal-title]", root);
  const hint = $("[data-cal-hint]", root);
  const inEl = $("[data-cal-in]", root);
  const outEl = $("[data-cal-out]", root);
  const inField = $("[data-cal-infield]", root);
  const outField = $("[data-cal-outfield]", root);
  const arrivalInput = $("#arrival");
  const departureInput = $("#departure");

  const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  const WD = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (s) => { const [y, m, da] = s.split("-").map(Number); return new Date(y, m - 1, da); };
  const fmt = (d) => d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });

  const todayD = new Date();
  todayD.setHours(0, 0, 0, 0);
  let arrival = arrivalInput.value ? parse(arrivalInput.value) : null;
  let departure = departureInput.value ? parse(departureInput.value) : null;
  let view = new Date((arrival || todayD).getFullYear(), (arrival || todayD).getMonth(), 1);

  const same = (a, b) => a && b && a.getTime() === b.getTime();

  // Passo atual da seleção: "in" (check-in) ou "out" (check-out).
  let selecting = arrival && !departure ? "out" : "in";

  const sync = () => {
    arrivalInput.value = arrival ? iso(arrival) : "";
    departureInput.value = departure ? iso(departure) : "";
    inEl.textContent = arrival ? fmt(arrival) : "Selecionar";
    outEl.textContent = departure ? fmt(departure) : "Selecionar";
    inField.setAttribute("aria-label", arrival ? `Alterar check-in de ${arrival.toLocaleDateString("pt-BR")}` : "Selecionar data de check-in");
    outField.setAttribute("aria-label", departure ? `Alterar check-out de ${departure.toLocaleDateString("pt-BR")}` : "Selecionar data de check-out");
    inField.setAttribute("aria-pressed", String(selecting === "in"));
    outField.setAttribute("aria-pressed", String(selecting === "out"));
    root.classList.toggle("rc-has-in", Boolean(arrival));
    root.classList.toggle("rc-has-out", Boolean(departure));
    root.classList.toggle("rc-pick-in", selecting === "in");
    root.classList.toggle("rc-pick-out", selecting === "out");
    if (selecting === "in") {
      hint.innerHTML = "<b>Passo 1 de 2</b> · selecione o <b>check-in</b>";
    } else if (!departure) {
      hint.innerHTML = "<b>Passo 2 de 2</b> · selecione o <b>check-out</b>";
    } else {
      hint.innerHTML = `Estadia de <b>${nightsBetween(iso(arrival), iso(departure))} noite(s)</b> · toque num campo para alterar`;
    }
  };

  const render = () => {
    title.textContent = `${MONTHS[view.getMonth()]} de ${view.getFullYear()}`;
    const startWd = new Date(view.getFullYear(), view.getMonth(), 1).getDay();
    const days = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
    let html = WD.map((w) => `<span class="rc-wd" aria-hidden="true">${w}</span>`).join("");
    for (let i = 0; i < startWd; i += 1) html += `<span class="rc-empty"></span>`;
    for (let day = 1; day <= days; day += 1) {
      const d = new Date(view.getFullYear(), view.getMonth(), day);
      const past = d < todayD;
      const cls = ["rc-day"];
      if (past) cls.push("is-past");
      if (same(d, arrival)) cls.push("is-start");
      if (same(d, departure)) cls.push("is-end");
      if (arrival && departure && d > arrival && d < departure) cls.push("is-range");
      if (same(d, todayD)) cls.push("is-today");
      const fullDate = d.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
      const selected = same(d, arrival) || same(d, departure);
      html += `<button type="button" class="${cls.join(" ")}" ${past ? "disabled" : ""} data-day="${iso(d)}" aria-label="${escapeHTML(fullDate)}" aria-selected="${selected}"${same(d, todayD) ? ' aria-current="date"' : ""}>${day}</button>`;
    }
    grid.innerHTML = html;
    refreshIcons();
  };

  const pick = (d) => {
    if (arrival && departure) {
      // Já tinha um intervalo completo selecionado — qualquer clique novo
      // reinicia a escolha (o dia clicado vira o novo check-in), em vez de
      // só empurrar o check-out.
      arrival = d;
      departure = null;
      selecting = "out";
    } else if (selecting === "in") {
      arrival = d;
      if (departure && departure <= d) departure = null;
      selecting = "out"; // avança automaticamente p/ o passo 2
    } else if (d <= arrival) {
      arrival = d; // escolheu antes do check-in -> vira o novo check-in
      departure = null;
    } else {
      departure = d;
    }
    sync();
    render();
  };

  grid.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-day]");
    if (btn && !btn.disabled) pick(parse(btn.dataset.day));
  });

  // Campos clicáveis: alternam o passo (escolher check-in / check-out).
  $("[data-cal-infield]", root).addEventListener("click", () => { selecting = "in"; sync(); render(); });
  $("[data-cal-outfield]", root).addEventListener("click", () => { if (arrival) { selecting = "out"; sync(); render(); } });

  grid.addEventListener("mouseover", (e) => {
    if (selecting !== "out" || !arrival) return;
    const btn = e.target.closest("[data-day]");
    if (!btn) return;
    const hov = parse(btn.dataset.day);
    grid.querySelectorAll("[data-day]").forEach((b) => {
      const bd = parse(b.dataset.day);
      b.classList.toggle("is-preview", bd > arrival && bd <= hov);
    });
  });
  grid.addEventListener("mouseleave", () => {
    grid.querySelectorAll(".is-preview").forEach((b) => b.classList.remove("is-preview"));
  });

  $("[data-cal-prev]", root).addEventListener("click", () => {
    const min = new Date(todayD.getFullYear(), todayD.getMonth(), 1);
    const prev = new Date(view.getFullYear(), view.getMonth() - 1, 1);
    view = prev < min ? min : prev;
    render();
  });
  $("[data-cal-next]", root).addEventListener("click", () => {
    view = new Date(view.getFullYear(), view.getMonth() + 1, 1);
    render();
  });

  // Atalho "ir para mês/ano": evita clicar em ">" dezenas de vezes pra uma
  // reserva distante. Abre dois selects (mês, ano) ao tocar no título.
  const jumpBox = $("[data-cal-jump]", root);
  const jumpMonth = $("[data-cal-jump-month]", root);
  const jumpYear = $("[data-cal-jump-year]", root);
  const YEARS_AHEAD = 2; // cobre reservas com bastante antecedência

  const fillJumpOptions = () => {
    jumpMonth.innerHTML = MONTHS
      .map((m, i) => `<option value="${i}">${m.charAt(0).toUpperCase() + m.slice(1)}</option>`)
      .join("");
    const startYear = todayD.getFullYear();
    jumpYear.innerHTML = Array.from({ length: YEARS_AHEAD + 1 }, (_, i) => startYear + i)
      .map((y) => `<option value="${y}">${y}</option>`)
      .join("");
  };

  const openJump = () => {
    fillJumpOptions();
    jumpMonth.value = String(view.getMonth());
    jumpYear.value = String(view.getFullYear());
    jumpBox.classList.remove("is-hidden");
    title.setAttribute("aria-expanded", "true");
  };

  const closeJump = () => {
    jumpBox.classList.add("is-hidden");
    title.setAttribute("aria-expanded", "false");
  };

  const goToJumpSelection = () => {
    const min = new Date(todayD.getFullYear(), todayD.getMonth(), 1);
    const target = new Date(Number(jumpYear.value), Number(jumpMonth.value), 1);
    view = target < min ? min : target;
    render();
  };

  title.addEventListener("click", () => {
    if (jumpBox.classList.contains("is-hidden")) openJump();
    else closeJump();
  });
  jumpMonth.addEventListener("change", goToJumpSelection);
  jumpYear.addEventListener("change", goToJumpSelection);
  document.addEventListener("click", (e) => {
    if (!jumpBox.classList.contains("is-hidden") && !jumpBox.contains(e.target) && e.target !== title) closeJump();
  });

  sync();
  render();
};

/* ---------- bind ---------- */
document.addEventListener("DOMContentLoaded", () => {
  loadPublicConfig();
  initEmbed();
  refreshIcons();
  prefillFromQuery();
  primeStoredSearch();
  initCalendar();
  initSteppers();
  updateSummary();

  $("#kids").addEventListener("change", buildAgesInputs);
  $("#search-form").addEventListener("submit", fetchAvailability);

  // Deep-link (Asksuite e afins): com as duas datas na query, já consulta a
  // disponibilidade em vez de parar no formulário preenchido — mesmo
  // comportamento do site da Casa, onde o prefill dispara a busca. Sem as duas
  // datas não faz nada: o hóspede continua no formulário, como antes.
  if (hasExplicitSearchQuery() && $("#arrival").value && $("#departure").value) {
    fetchAvailability();
  }

  $("#room-list").addEventListener("click", (e) => {
    const card = e.target.closest("[data-room]");
    if (!card) return;
    toggleRoomSelection(decodeRoomData(card.dataset.room));
  });

  $("[data-rooms-continue]")?.addEventListener("click", confirmRoomSelection);

  $("#back-to-search").addEventListener("click", () => { goToStep(1); goToSearchStep("dates"); });
  $("#back-to-rooms").addEventListener("click", () => { if (!guardActivePix()) goToStep(2); });

  // Sub-passos da etapa 1: datas -> hóspedes
  $("[data-search-next]")?.addEventListener("click", () => {
    if (!$("#arrival").value || !$("#departure").value) {
      showNotice("Selecione o check-in e o check-out.");
      return;
    }
    clearNotice();
    goToSearchStep("guests");
  });
  $("[data-search-back]")?.addEventListener("click", () => goToSearchStep("dates"));

  $("#c-number").addEventListener("input", (e) => { maskCardNumber(e.target); updateCardPreview(); });
  $("#c-name").addEventListener("input", updateCardPreview);
  $("#c-exp").addEventListener("input", (e) => { maskExpiry(e.target); updateCardPreview(); });
  $("#c-cvv").addEventListener("input", (e) => onlyDigits(e.target));

  // Máscaras dos dados do hóspede
  $("#g-phone").addEventListener("input", (e) => maskPhone(e.target));
  $("#g-doc").addEventListener("input", (e) => maskDocument(e.target));
  $$("[data-doctype]").forEach((card) => {
    card.addEventListener("click", () => setDocType(card.dataset.doctype));
  });
  syncDocumentInputMode(); // aplica placeholder/inputmode do tipo inicial
  syncDocumentInputMode();
  $$("input, select").forEach((field) => {
    const clearInvalid = () => field.removeAttribute("aria-invalid");
    field.addEventListener("input", clearInvalid);
    field.addEventListener("change", clearInvalid);
  });

  // Persiste hóspede e parcelas conforme o usuário preenche
  ["#g-first", "#g-last", "#g-phone", "#g-email", "#g-doctype", "#g-doc"].forEach((sel) => {
    $(sel)?.addEventListener("input", persistState);
  });
  $("#c-inst")?.addEventListener("change", persistState);

  $("#checkout-form").addEventListener("submit", submitCheckout);

  // Sub-etapa 1: escolha da forma de pagamento (PIX / Cartão)
  $$("[data-pay-method]").forEach((t) => t.addEventListener("click", () => setPayMethod(t.dataset.payMethod)));

  // Retoma de onde o usuário parou (se houver); senão, começa no PIX.
  restoreState().then((restored) => { if (!restored) setPayMethod("pix"); });

  // Navegação entre as sub-etapas do pagamento
  $$("[data-paynext]").forEach((b) => b.addEventListener("click", () => {
    const target = b.dataset.paynext;
    if (target === "pay" && !guestValid()) return;
    goToPayStep(target);
  }));
  $$("[data-payback]").forEach((b) => b.addEventListener("click", () => goToPayStep(b.dataset.payback)));

  // Copiar o código PIX (copia e cola)
  $("[data-pix-copy]")?.addEventListener("click", async () => {
    const code = $("[data-pix-code]")?.value;
    if (!code) return;
    try { await navigator.clipboard.writeText(code); } catch (_) {}
    const b = $("[data-pix-copy]");
    const old = b.innerHTML;
    b.innerHTML = '<i data-lucide="check" aria-hidden="true"></i> Copiado';
    refreshIcons();
    setTimeout(() => { b.innerHTML = old; refreshIcons(); }, 1800);
  });

  // Galeria ampliada das acomodações: controles, miniaturas, swipe e foco preso.
  $$("[data-gallery-close]").forEach((button) => button.addEventListener("click", closeRoomGallery));
  $("[data-gallery-prev]")?.addEventListener("click", () => moveRoomGallery(-1));
  $("[data-gallery-next]")?.addEventListener("click", () => moveRoomGallery(1));
  const galleryModal = $("[data-gallery-modal]");
  galleryModal?.addEventListener("click", (event) => {
    const thumb = event.target.closest("[data-gallery-thumb]");
    if (!thumb) return;
    roomGalleryState.index = Number(thumb.dataset.galleryThumb) || 0;
    renderRoomGallery();
  });
  galleryModal?.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") { event.preventDefault(); moveRoomGallery(-1); return; }
    if (event.key === "ArrowRight") { event.preventDefault(); moveRoomGallery(1); return; }
    if (event.key !== "Tab") return;
    const focusable = $$("button:not([tabindex='-1']):not([disabled]), [href]", galleryModal);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  let galleryTouchX = null;
  $(".gallery-stage", galleryModal)?.addEventListener("touchstart", (event) => {
    galleryTouchX = event.changedTouches[0]?.clientX ?? null;
  }, { passive: true });
  $(".gallery-stage", galleryModal)?.addEventListener("touchend", (event) => {
    if (galleryTouchX == null) return;
    const delta = (event.changedTouches[0]?.clientX ?? galleryTouchX) - galleryTouchX;
    galleryTouchX = null;
    if (Math.abs(delta) > 48) moveRoomGallery(delta > 0 ? -1 : 1);
  }, { passive: true });

  $$("[data-noavail-close]:not([data-noavail-reset])").forEach((b) => b.addEventListener("click", closeNoAvailability));
  $("[data-noavail-reset]")?.addEventListener("click", () => {
    noAvailabilityTrigger = null;
    closeNoAvailability();
    goToStep(1);
    goToSearchStep("dates");
  });
  $("[data-noavail]")?.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const focusable = $$("button:not([tabindex='-1']):not([disabled])", event.currentTarget);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if ($("[data-gallery-modal]")?.hidden === false) closeRoomGallery();
    else closeNoAvailability();
  });
});
