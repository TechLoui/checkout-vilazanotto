import qs from "qs";
import { config } from "./config.js";

const baseHeaders = () => ({
  ClientId: config.artax.clientId,
  ClientSecret: config.artax.clientSecret,
  Accept: "application/json"
});

class ArtaxError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = "ArtaxError";
    this.status = status;
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

// Fotos locais publicadas junto do site. Sao usadas apenas quando o Artax nao
// devolve uma galeria propria, garantindo URLs absolutas para parceiros.
const ROOM_FALLBACK_IMAGES = {
  bangalo: [
    "5-2-scaled.webp",
    "1-2-1-scaled.webp",
    "2-1-1-scaled.webp",
    "22-scaled.webp",
    "8-scaled.webp",
    "4-scaled.webp"
  ],
  "flat-casal": ["Flat-21-scaled.webp", "Flat-23-scaled.webp", "Flat-31-scaled.webp"],
  "flat-triplo": [
    "Flat-31-scaled.webp",
    "Flat-32-scaled.webp",
    "Flat-33-scaled.webp",
    "Flat-36-scaled.webp",
    "Flat-312-scaled.webp",
    "Flat-313-scaled.webp"
  ],
  "flat-quadruplo": ["Flat-4-scaled.webp", "Flat-43-scaled.webp", "Flat-44-scaled.webp", "Flat-45-scaled.webp"]
};

const roomKindFromName = (name) => {
  const normalized = String(name || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  if (normalized.includes("bangal")) return "bangalo";
  if (normalized.includes("quadru") || /flat\s*4\b/.test(normalized)) return "flat-quadruplo";
  if (normalized.includes("tripl") || /flat\s*3\b/.test(normalized)) return "flat-triplo";
  if (normalized.includes("casal") || /flat\s*2\b/.test(normalized) || normalized.includes("flat")) return "flat-casal";
  return null;
};

const fallbackRoomImages = (roomName) => {
  const filenames = ROOM_FALLBACK_IMAGES[roomKindFromName(roomName)] || [];
  return filenames.map((filename) => `${config.siteUrl}/assets/gallery/${filename}`);
};

const imageValues = (value) => {
  if (!value) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(imageValues);
  if (typeof value !== "object") return [];
  const knownKeys = ["url", "src", "href", "path", "image", "large", "medium", "thumbnail", "thumb"];
  const knownValues = knownKeys.flatMap((key) => imageValues(value[key]));
  return knownValues.length ? knownValues : Object.values(value).flatMap(imageValues);
};

const absoluteImageUrl = (value) => {
  const src = String(value || "").trim();
  if (!src || !/\.(?:avif|gif|jpe?g|png|webp)(?:[?#].*)?$/i.test(src)) return null;
  try {
    return new URL(src, `${config.artax.baseUrl}/`).href;
  } catch {
    return null;
  }
};

const existingRoomImages = (option) => {
  const fields = [
    "main_image", "image", "photo", "cover", "cover_image", "thumbnail",
    "images", "photos", "pictures", "gallery", "media", "room_images"
  ];
  return [...new Set(
    fields
      .flatMap((field) => imageValues(option?.[field]))
      .map(absoluteImageUrl)
      .filter(Boolean)
  )];
};

/** Preserva fotos do Artax e usa a galeria da Villa somente como fallback. */
const enrichRoomImages = (data) => {
  if (!data?.rooms || Array.isArray(data.rooms)) return data;
  for (const plans of Object.values(data.rooms)) {
    for (const option of Object.values(plans || {})) {
      if (!option || typeof option !== "object") continue;
      const images = existingRoomImages(option);
      const resolved = images.length ? images : fallbackRoomImages(option?.room_name);
      if (resolved.length) {
        option.images = resolved;
        option.image = resolved[0];
      }
    }
  }
  return data;
};

/**
 * Verifica disponibilidade de quartos.
 * GET /rooms/availability — parâmetros enviados na query string.
 */
export const checkAvailability = async ({ arrival_date, departure_date, adults, kids, ages = [] }) => {
  const query = qs.stringify(
    { arrival_date, departure_date, adults, kids, ages },
    { arrayFormat: "indices", encodeValuesOnly: true }
  );
  const url = `${config.artax.baseUrl}/rooms/availability?${query}`;

  const response = await fetch(url, { method: "GET", headers: baseHeaders() });
  const data = await parseJsonSafe(response);

  if (!response.ok) {
    throw new ArtaxError(data.error || "Falha ao consultar disponibilidade.", response.status, data);
  }
  return enrichRoomImages(data);
};

/**
 * Cria a reserva.
 * POST /booking/create — corpo em application/x-www-form-urlencoded usando a
 * notação de arrays do PHP (ex.: room_units[301][price]=600,
 * room_units[301][guests][0][first_name]=Maria).
 */
export const createBooking = async (payload) => {
  const body = qs.stringify(payload, { arrayFormat: "indices", encodeValuesOnly: false });
  const url = `${config.artax.baseUrl}/booking/create`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...baseHeaders(),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
  const data = await parseJsonSafe(response);

  if (!response.ok || !data.booking_id) {
    throw new ArtaxError(data.error || "Falha ao criar a reserva.", response.status, data);
  }
  return data; // { booking_id }
};

/** Lista os centros de custo (para categorizar pagamentos, se necessário). */
export const listCostCenters = async () => {
  const response = await fetch(`${config.artax.baseUrl}/cost-centers`, {
    method: "GET",
    headers: baseHeaders()
  });
  const data = await parseJsonSafe(response);
  if (!response.ok) {
    throw new ArtaxError(data.error || "Falha ao listar centros de custo.", response.status, data);
  }
  return data;
};

/** Lista os métodos de pagamento (para descobrir os IDs de PIX e Cartão). */
export const listPaymentMethods = async () => {
  const response = await fetch(`${config.artax.baseUrl}/payment-methods`, {
    method: "GET",
    headers: baseHeaders()
  });
  const data = await parseJsonSafe(response);
  if (!response.ok) {
    throw new ArtaxError(data.error || "Falha ao listar métodos de pagamento.", response.status, data);
  }
  return data;
};

/**
 * Adiciona pagamento(s) a uma reserva existente.
 * POST /booking/{booking_id}/payments — corpo JSON.
 * Cada pagamento: { payment_method_id, gross_amount, installments, due_date,
 *                   obs?, confirmed?, cost_center_id? }
 */
export const addBookingPayment = async (bookingId, payments) => {
  const response = await fetch(`${config.artax.baseUrl}/booking/${bookingId}/payments`, {
    method: "POST",
    headers: { ...baseHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ payments })
  });
  const data = await parseJsonSafe(response);
  if (!response.ok) {
    throw new ArtaxError(data.error || "Falha ao registrar o pagamento na reserva.", response.status, data);
  }
  return data; // { message, bills: [...] }
};

export { ArtaxError };
