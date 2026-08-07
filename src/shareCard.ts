// Spieler- und Platzkarten werden als Link mit Nutzlast im Fragment (#) geteilt.
//
// Das Fragment ist der Clou: Browser senden es nicht an den Server. Ein Mitspieler
// zeigt seinen QR-Code, das andere Gerät scannt ihn mit der Kamera-App des Systems –
// kein eingebauter Scanner, keine Kamera-Berechtigung in der App, und auf iOS
// genauso wie auf Android. Die Daten wandern dabei ausschliesslich von Geraet zu
// Geraet; weder Netlify noch sonst jemand sieht sie.

export type PlayerCard = {
  kind: "player";
  name: string;
  hcpIndex: number;
};

export type CourseCard = {
  kind: "course";
  name: string;
  courseRating: number;
  slopeRating: number;
  par: number;
  tee?: string;
  holeCount?: 9 | 18;
  /** Par und Stroke Index je Loch, sofern die Scorekarte hinterlegt ist. */
  holeData?: { par: number; si: number }[];
};

export type ShareCard = PlayerCard | CourseCard;

export const SHARE_CARD_VERSION = 1;

const PLAYER_PARAM = "p";
const COURSE_PARAM = "c";

function round1(value: number) {
  return Math.round(value * 10) / 10;
}

// btoa/atob arbeiten byteweise, deshalb der Umweg ueber TextEncoder: Umlaute
// ueberleben sonst den Weg durch den Link nicht.
function toBase64Url(input: string) {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(input: string) {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
}

// Par 3 bis 6 passt in eine Ziffer, Stroke Index 1 bis 18 in ein Base36-Zeichen.
// Damit bleibt eine 18-Loch-Scorekarte bei 36 Zeichen statt ueber 200.
function packHoles(holes: { par: number; si: number }[]) {
  return {
    p: holes.map(hole => String(Math.min(9, Math.max(3, Math.round(hole.par))))).join(""),
    s: holes.map(hole => Math.min(35, Math.max(1, Math.round(hole.si))).toString(36)).join(""),
  };
}

function unpackHoles(pars: unknown, sis: unknown) {
  if (typeof pars !== "string" || typeof sis !== "string") return undefined;
  if (!pars.length || pars.length !== sis.length) return undefined;
  const holes = [...pars].map((par, index) => ({
    par: parseInt(par, 10),
    si: parseInt(sis[index], 36),
  }));
  return holes.every(hole => Number.isFinite(hole.par) && Number.isFinite(hole.si)) ? holes : undefined;
}

function encodePayload(payload: Record<string, unknown>) {
  return toBase64Url(JSON.stringify(payload));
}

/** Baut den Link, der hinter dem QR-Code steckt. */
export function buildShareUrl(card: ShareCard, origin: string) {
  const base = String(origin || "").replace(/[/#?]+$/, "");
  if (card.kind === "player") {
    const payload = { v: SHARE_CARD_VERSION, n: card.name, i: round1(card.hcpIndex) };
    return `${base}/#${PLAYER_PARAM}=${encodePayload(payload)}`;
  }
  const payload: Record<string, unknown> = {
    v: SHARE_CARD_VERSION,
    n: card.name,
    cr: card.courseRating,
    sr: card.slopeRating,
    par: card.par,
  };
  if (card.tee) payload.te = card.tee;
  if (card.holeCount) payload.hc = card.holeCount;
  if (card.holeData?.length) Object.assign(payload, packHoles(card.holeData));
  return `${base}/#${COURSE_PARAM}=${encodePayload(payload)}`;
}

function parsePayload(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fromBase64Url(raw));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function num(value: unknown) {
  const parsed = typeof value === "number" ? value : parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown) {
  return String(value ?? "").trim().slice(0, 60);
}

/**
 * Liest eine Karte aus dem Fragment eines Links. Unbekannte oder kaputte
 * Nutzlasten geben null zurueck – ein fremder Link darf nichts kaputt machen.
 */
export function parseShareHash(hash: string): ShareCard | null {
  const raw = String(hash || "").replace(/^#/, "");
  if (!raw) return null;
  const match = /^([pc])=([A-Za-z0-9\-_]+)$/.exec(raw);
  if (!match) return null;
  const [, kind, encoded] = match;
  const payload = parsePayload(encoded);
  if (!payload) return null;
  if (num(payload.v) !== SHARE_CARD_VERSION) return null;

  const name = text(payload.n);
  if (!name) return null;

  if (kind === PLAYER_PARAM) {
    const hcpIndex = num(payload.i);
    if (hcpIndex === null || hcpIndex < -10 || hcpIndex > 54) return null;
    return { kind: "player", name, hcpIndex: round1(hcpIndex) };
  }

  const courseRating = num(payload.cr);
  const slopeRating = num(payload.sr);
  const par = num(payload.par);
  if (courseRating === null || slopeRating === null || par === null) return null;
  if (slopeRating < 55 || slopeRating > 155) return null;

  const card: CourseCard = { kind: "course", name, courseRating, slopeRating, par };
  const tee = text(payload.te);
  if (tee) card.tee = tee;
  const holeCount = num(payload.hc);
  if (holeCount === 9 || holeCount === 18) card.holeCount = holeCount;
  const holes = unpackHoles(payload.p, payload.s);
  if (holes) {
    card.holeData = holes;
    if (!card.holeCount) card.holeCount = holes.length === 9 ? 9 : 18;
  }
  return card;
}

/** Kurzbeschreibung für den Übernehmen-Dialog. */
export function describeShareCard(card: ShareCard) {
  if (card.kind === "player") {
    return `${card.name} · HCP-Index ${card.hcpIndex.toFixed(1).replace(".", ",")}`;
  }
  const parts = [`CR ${card.courseRating}`, `SR ${card.slopeRating}`, `Par ${card.par}`];
  if (card.tee) parts.push(card.tee);
  if (card.holeData?.length) parts.push("mit Scorekarte");
  return `${card.name} · ${parts.join(" · ")}`;
}
