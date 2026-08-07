/**
 * Gemeinsame, seiteneffektfreie Logik des Nutzungszaehlers.
 *
 * Wird von der Zaehl-Function (netlify/functions/usage.mts) und vom Client
 * (src/usagePing.ts) benutzt, damit ID-Format und Aufbewahrungsdauer nicht
 * zwischen Frontend, Serverpruefung und Datenschutztext auseinanderlaufen.
 */

/** Schluessel im Blob-Store: "pings/<YYYY-MM-DD>/<installId>". Der Wert ist bedeutungslos. */
export const USAGE_KEY_PREFIX = "pings/";

/** Nach so vielen Tagen wird eine Zaehlzeile geloescht. */
export const USAGE_RETENTION_DAYS = 400;

export const USAGE_INSTALL_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type UsageEntry = {
  key: string;
  day: string;
  installId: string;
};

export type UsageWindows = {
  today: string;
  since7: string;
  since30: string;
  cutoff: string;
};

export type UsageTotals = {
  activeToday: number;
  activeLast7Days: number;
  activeLast30Days: number;
  total: number;
};

/** Kalendertag in UTC als "YYYY-MM-DD". Serverseitig immer UTC, damit die Tagesbuckets stabil sind. */
export function utcDay(offsetDays = 0, now = new Date()) {
  const date = new Date(now.getTime());
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

export function usageKey(day: string, installId: string) {
  return `${USAGE_KEY_PREFIX}${day}/${installId}`;
}

export function parseUsageKey(key: string): UsageEntry | null {
  if (typeof key !== "string" || !key.startsWith(USAGE_KEY_PREFIX)) return null;
  const rest = key.slice(USAGE_KEY_PREFIX.length);
  const separator = rest.indexOf("/");
  if (separator <= 0) return null;

  const day = rest.slice(0, separator);
  const installId = rest.slice(separator + 1);
  if (!DAY_PATTERN.test(day) || !USAGE_INSTALL_ID_PATTERN.test(installId)) return null;

  return { key, day, installId };
}

export function usageWindows(now = new Date()): UsageWindows {
  return {
    today: utcDay(0, now),
    since7: utcDay(-6, now),
    since30: utcDay(-29, now),
    cutoff: utcDay(-USAGE_RETENTION_DAYS, now),
  };
}

/** Zaehlt verschiedene Installations-IDs je Zeitfenster; abgelaufene Zeilen bleiben aussen vor. */
export function aggregateUsage(entries: UsageEntry[], windows: UsageWindows): UsageTotals {
  const today = new Set<string>();
  const last7 = new Set<string>();
  const last30 = new Set<string>();
  const all = new Set<string>();

  for (const entry of entries) {
    if (entry.day < windows.cutoff) continue;
    all.add(entry.installId);
    if (entry.day === windows.today) today.add(entry.installId);
    if (entry.day >= windows.since7) last7.add(entry.installId);
    if (entry.day >= windows.since30) last30.add(entry.installId);
  }

  return {
    activeToday: today.size,
    activeLast7Days: last7.size,
    activeLast30Days: last30.size,
    total: all.size,
  };
}

/** Zu loeschende Schluessel, begrenzt auf max Eintraege pro Aufruf (Laufzeitschutz). */
export function selectStaleKeys(entries: UsageEntry[], cutoff: string, max: number) {
  const stale: string[] = [];
  for (const entry of entries) {
    if (entry.day >= cutoff) continue;
    stale.push(entry.key);
    if (stale.length >= max) break;
  }
  return stale;
}
