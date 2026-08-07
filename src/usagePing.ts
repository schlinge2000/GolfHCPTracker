/**
 * Anonymer Nutzungszaehler.
 *
 * Ziel ist ausschliesslich die Frage "wie viele Geraete nutzen die App?".
 * Deshalb verlaesst hier nur eine zufaellig erzeugte Installations-ID das
 * Geraet - keine Namen, keine Runden, keine Handicap-Werte. Pro Kalendertag
 * wird hoechstens ein Ping gesendet; scheitert er (offline, Endpoint nicht
 * erreichbar), bleibt der Tag ungezaehlt und wird beim naechsten Start oder
 * beim naechsten "online"-Event erneut versucht.
 *
 * Die reinen Funktionen (toDayString, normalizeUsageState, shouldSendPing,
 * createInstallId) sind ohne Browser-APIs testbar; alles mit Seiteneffekt
 * liegt darunter.
 */

import { USAGE_INSTALL_ID_PATTERN, USAGE_RETENTION_DAYS } from "./usageAggregate";

export const USAGE_STORAGE_KEY = "golf_hcp_usage";

/** Gleiche Quelle wie die Function, damit Datenschutztext und Server nicht auseinanderlaufen. */
export const USAGE_ID_RETENTION_DAYS = USAGE_RETENTION_DAYS;

const DEFAULT_ENDPOINT = "/api/usage";
const MAX_ATTEMPTS_PER_SESSION = 5;

export type UsageState = {
  enabled: boolean;
  installId: string;
  lastSentDay: string;
};

export type UsageStats = {
  activeToday: number;
  activeLast7Days: number;
  activeLast30Days: number;
  total: number;
};

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Lokaler Kalendertag als "YYYY-MM-DD" (bewusst lokal, nicht UTC: "einmal pro Tag" aus Nutzersicht). */
export function toDayString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function isValidInstallId(value: unknown) {
  return typeof value === "string" && USAGE_INSTALL_ID_PATTERN.test(value);
}

export function isValidDay(value: unknown) {
  return typeof value === "string" && DAY_PATTERN.test(value);
}

/** UUID v4, mit Fallback fuer Browser ohne crypto.randomUUID (z. B. Safari < 15.4). */
export function createInstallId() {
  const cryptoObj = typeof crypto !== "undefined" ? crypto : undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") return cryptoObj.randomUUID();

  const bytes = new Uint8Array(16);
  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Der Zaehler ist standardmaessig aktiv; nur ein explizites enabled:false schaltet ihn ab. */
export function normalizeUsageState(raw: unknown): UsageState {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const enabled = source.enabled !== false;
  return {
    enabled,
    // Ohne Zaehler existiert auch keine ID.
    installId: enabled && isValidInstallId(source.installId) ? String(source.installId) : "",
    lastSentDay: isValidDay(source.lastSentDay) ? String(source.lastSentDay) : "",
  };
}

export function shouldSendPing(state: UsageState, today: string) {
  return state.enabled && state.lastSentDay !== today;
}

/** Opt-out loescht die ID mit: nach dem Wiedereinschalten entsteht eine neue, nicht verknuepfbare ID. */
export function usageStateAfterToggle(state: UsageState, enabled: boolean): UsageState {
  if (!enabled) return { enabled: false, installId: "", lastSentDay: "" };
  return { ...state, enabled: true };
}

function getEndpoint() {
  const configured = import.meta.env?.VITE_USAGE_PING_URL;
  return typeof configured === "string" && configured.trim() ? configured.trim() : DEFAULT_ENDPOINT;
}

function loadState(): UsageState {
  try {
    const raw = localStorage.getItem(USAGE_STORAGE_KEY);
    if (raw) return normalizeUsageState(JSON.parse(raw));
  } catch (e) {}
  return normalizeUsageState(null);
}

function saveState(state: UsageState) {
  try {
    localStorage.setItem(USAGE_STORAGE_KEY, JSON.stringify(state));
  } catch (e) {}
}

let attempts = 0;
let inFlight = false;
let pendingPing: Promise<void> | null = null;

async function sendPing() {
  if (typeof fetch !== "function") return;
  if (inFlight || attempts >= MAX_ATTEMPTS_PER_SESSION) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;

  const today = toDayString();
  let state = loadState();
  if (!shouldSendPing(state, today)) return;

  if (!state.installId) {
    state = { ...state, installId: createInstallId() };
    saveState(state);
  }

  inFlight = true;
  attempts += 1;
  try {
    const response = await fetch(getEndpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installId: state.installId }),
      credentials: "omit",
      cache: "no-store",
      keepalive: true,
    });
    if (!response.ok) return;

    // Frisch laden, damit ein Opt-out waehrend des Requests nicht ueberschrieben wird.
    const current = loadState();
    if (current.enabled) saveState({ ...current, lastSentDay: today });
  } catch (e) {
    // Offline oder Endpoint nicht erreichbar: Tag bleibt offen, naechster Versuch spaeter.
  } finally {
    inFlight = false;
  }
}

function schedulePing() {
  pendingPing = sendPing();
  return pendingPing;
}

/**
 * Wartet auf einen laufenden Ping. Sonst laedt die Anzeige die Zahlen, waehrend
 * der eigene Ping noch unterwegs ist, und zaehlt das eigene Geraet nicht mit.
 * sendPing faengt eigene Fehler ab, das Promise wird also nie rejected.
 */
export function whenUsagePingSettled() {
  return pendingPing ?? Promise.resolve();
}

export function isUsagePingEnabled() {
  return loadState().enabled;
}

export function setUsagePingEnabled(enabled: boolean) {
  const next = usageStateAfterToggle(loadState(), enabled);
  saveState(next);
  // Beim Einschalten direkt mitzaehlen, sonst faellt der heutige Tag hinten runter.
  if (next.enabled) void schedulePing();
  return next.enabled;
}

export function initUsagePing() {
  if (typeof window === "undefined") return;
  void schedulePing();
  window.addEventListener("online", () => {
    void schedulePing();
  });
}

function toCount(value: unknown) {
  const count = typeof value === "number" ? value : parseInt(String(value), 10);
  return Number.isFinite(count) && count >= 0 ? count : 0;
}

export async function fetchUsageStats(): Promise<UsageStats | null> {
  if (typeof fetch !== "function") return null;
  try {
    const response = await fetch(getEndpoint(), { method: "GET", credentials: "omit", cache: "no-store" });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data || typeof data !== "object") return null;
    return {
      activeToday: toCount((data as Record<string, unknown>).activeToday),
      activeLast7Days: toCount((data as Record<string, unknown>).activeLast7Days),
      activeLast30Days: toCount((data as Record<string, unknown>).activeLast30Days),
      total: toCount((data as Record<string, unknown>).total),
    };
  } catch (e) {
    return null;
  }
}
