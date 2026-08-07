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

/**
 * Ein komplettes Spiel-Setup zum Mitspielen auf dem eigenen Geraet. Uebertragen
 * werden nur die Eingaben, nicht die abgeleiteten Werte: Course Handicaps und
 * Vorgabenverteilung rechnet jedes Geraet aus denselben Zahlen selbst neu. Damit
 * kommen alle zwangslaeufig auf dasselbe Ergebnis – Voraussetzung dafuer, dass
 * ein Vergleich der Abrechnungen am Ende ueberhaupt etwas aussagt.
 */
export type GameCard = {
  kind: "game";
  date: string;
  holeCount: 9 | 18;
  course: Omit<CourseCard, "kind">;
  formats: string[];
  /** Positionen der beiden Kontrahenten in `players`, nur fuer Matchplay. */
  matchup: number[];
  handicap: { mode: string; percent: number };
  stake: { skin: number; match: number; nassau: number; point: number };
  players: { name: string; hcpIndex: number }[];
};

export type ShareCard = PlayerCard | CourseCard | GameCard;

export const GAME_CARD_FORMATS = ["matchplay", "nassau", "skins", "wolf", "bbb"] as const;
export const GAME_CARD_HANDICAP_MODES = ["difference", "full", "gross"] as const;
const MAX_GAME_PLAYERS = 8;

export const SHARE_CARD_VERSION = 1;

const PLAYER_PARAM = "p";
const COURSE_PARAM = "c";
const GAME_PARAM = "g";

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
  if (card.kind === "course") {
    return `${base}/#${COURSE_PARAM}=${encodePayload({v: SHARE_CARD_VERSION, ...packCourse(card)})}`;
  }
  const payload = {
    v: SHARE_CARD_VERSION,
    d: card.date,
    hc: card.holeCount,
    c: packCourse(card.course),
    f: card.formats,
    mu: card.matchup,
    g: [card.handicap.mode, card.handicap.percent],
    st: [card.stake.skin, card.stake.match, card.stake.nassau, card.stake.point],
    pl: card.players.map(player => [player.name, round1(player.hcpIndex)]),
  };
  return `${base}/#${GAME_PARAM}=${encodePayload(payload)}`;
}

function packCourse(course: Omit<CourseCard, "kind">) {
  const payload: Record<string, unknown> = {
    n: course.name,
    cr: course.courseRating,
    sr: course.slopeRating,
    par: course.par,
  };
  if (course.tee) payload.te = course.tee;
  if (course.holeCount) payload.hc = course.holeCount;
  if (course.holeData?.length) Object.assign(payload, packHoles(course.holeData));
  return payload;
}

function unpackCourse(raw: unknown): Omit<CourseCard, "kind"> | null {
  if (!raw || typeof raw !== "object") return null;
  const payload = raw as Record<string, unknown>;
  const name = text(payload.n);
  const courseRating = num(payload.cr);
  const slopeRating = num(payload.sr);
  const par = num(payload.par);
  if (!name || courseRating === null || slopeRating === null || par === null) return null;
  if (slopeRating < 55 || slopeRating > 155) return null;

  const course: Omit<CourseCard, "kind"> = { name, courseRating, slopeRating, par };
  const tee = text(payload.te);
  if (tee) course.tee = tee;
  const holeCount = num(payload.hc);
  if (holeCount === 9 || holeCount === 18) course.holeCount = holeCount;
  const holes = unpackHoles(payload.p, payload.s);
  if (holes) {
    course.holeData = holes;
    if (!course.holeCount) course.holeCount = holes.length === 9 ? 9 : 18;
  }
  return course;
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
  const match = /^([pcg])=([A-Za-z0-9\-_]+)$/.exec(raw);
  if (!match) return null;
  const [, kind, encoded] = match;
  const payload = parsePayload(encoded);
  if (!payload) return null;
  if (num(payload.v) !== SHARE_CARD_VERSION) return null;

  if (kind === PLAYER_PARAM) {
    const name = text(payload.n);
    const hcpIndex = num(payload.i);
    if (!name) return null;
    if (hcpIndex === null || hcpIndex < -10 || hcpIndex > 54) return null;
    return { kind: "player", name, hcpIndex: round1(hcpIndex) };
  }

  if (kind === COURSE_PARAM) {
    const course = unpackCourse(payload);
    return course ? { kind: "course", ...course } : null;
  }

  return parseGamePayload(payload);
}

function parseGamePayload(payload: Record<string, unknown>): GameCard | null {
  const course = unpackCourse(payload.c);
  if (!course) return null;

  const holeCount = num(payload.hc);
  if (holeCount !== 9 && holeCount !== 18) return null;

  const rawPlayers = Array.isArray(payload.pl) ? payload.pl : [];
  const players = rawPlayers.slice(0, MAX_GAME_PLAYERS).map(entry => {
    const pair = Array.isArray(entry) ? entry : [];
    const name = text(pair[0]);
    const hcpIndex = num(pair[1]);
    return name && hcpIndex !== null && hcpIndex >= -10 && hcpIndex <= 54
      ? { name, hcpIndex: round1(hcpIndex) }
      : null;
  });
  if (players.length < 2 || players.some(player => player === null)) return null;

  const formats = (Array.isArray(payload.f) ? payload.f : [])
    .map(format => String(format))
    .filter(format => (GAME_CARD_FORMATS as readonly string[]).includes(format));
  if (!formats.length) return null;

  const rawHandicap = Array.isArray(payload.g) ? payload.g : [];
  const mode = String(rawHandicap[0] ?? "");
  if (!(GAME_CARD_HANDICAP_MODES as readonly string[]).includes(mode)) return null;
  const percent = num(rawHandicap[1]);
  if (percent === null || percent < 0 || percent > 100) return null;

  const rawStake = Array.isArray(payload.st) ? payload.st : [];
  const [skin, match, nassau, point] = [0, 1, 2, 3].map(index => {
    const value = num(rawStake[index]);
    return value === null || value < 0 ? 1 : value;
  });

  const matchup = (Array.isArray(payload.mu) ? payload.mu : [])
    .map(index => num(index))
    .filter((index): index is number => index !== null && Number.isInteger(index) && index >= 0 && index < players.length);
  if (formats.includes("matchplay") && matchup.length !== 2) return null;

  return {
    kind: "game",
    date: text(payload.d) || new Date().toISOString().slice(0, 10),
    holeCount,
    course,
    formats,
    matchup: matchup.length === 2 ? matchup : [],
    handicap: { mode, percent },
    stake: { skin, match, nassau, point },
    players: players as { name: string; hcpIndex: number }[],
  };
}

/** Kurzbeschreibung für den Übernehmen-Dialog. */
export function describeShareCard(card: ShareCard) {
  if (card.kind === "player") {
    return `${card.name} · HCP-Index ${card.hcpIndex.toFixed(1).replace(".", ",")}`;
  }
  if (card.kind === "game") {
    const formats = card.formats.length === 1 ? "1 Format" : `${card.formats.length} Formate`;
    return `${card.course.name} · ${card.holeCount} Loch · ${card.players.length} Spieler · ${formats}`;
  }
  const parts = [`CR ${card.courseRating}`, `SR ${card.slopeRating}`, `Par ${card.par}`];
  if (card.tee) parts.push(card.tee);
  if (card.holeData?.length) parts.push("mit Scorekarte");
  return `${card.name} · ${parts.join(" · ")}`;
}
