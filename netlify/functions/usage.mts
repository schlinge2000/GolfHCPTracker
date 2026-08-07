/**
 * Anonymer Nutzungszaehler (Netlify Function + Netlify Blobs).
 *
 * POST /api/usage  -> merkt sich "diese Installations-ID war heute aktiv"
 * GET  /api/usage  -> aggregierte Zahlen (heute / 7 Tage / 30 Tage / gesamt)
 *
 * Gespeichert wird ausschliesslich ein leerer Blob unter dem Schluessel
 * "pings/<tag>/<installId>". Zweimal derselbe Schluessel ist derselbe Blob,
 * damit ist die Deduplizierung pro Tag geschenkt. Bewusst nicht gespeichert:
 * IP-Adresse, User-Agent, Referrer, Uhrzeit. Es werden keine Cookies gesetzt.
 *
 * Netlify Blobs gehoert zur Hosting-Plattform, es kommt also kein weiterer
 * Dienstleister hinzu. Der Tag kommt vom Server, nicht vom Client.
 */
import { getStore } from "@netlify/blobs";

import {
  aggregateUsage,
  parseUsageKey,
  selectStaleKeys,
  usageKey,
  usageWindows,
  USAGE_INSTALL_ID_PATTERN,
  USAGE_KEY_PREFIX,
  USAGE_RETENTION_DAYS,
  utcDay,
  type UsageEntry,
} from "../../src/usageAggregate";

/** Ohne @types/node: process.env nur lesend und defensiv anfassen. */
const env: Record<string, string | undefined> = (globalThis as any).process?.env ?? {};

const MAX_BODY_BYTES = 512;
const MAX_DELETES_PER_RUN = 500;
const PRUNE_PROBABILITY = 0.02;

type UsageStore = {
  set: (key: string, value: string) => Promise<unknown>;
  delete: (key: string) => Promise<unknown>;
  list: (options: { prefix: string }) => Promise<{ blobs: { key: string }[] }>;
};

function usageStore(): UsageStore {
  // Deploy-Previews und Branch-Deploys bekommen ihren eigenen Store, sonst
  // wuerde jeder Testaufruf den Produktionszaehler hochtreiben.
  const context = env.CONTEXT || "dev";
  const name = context === "production" ? "usage" : `usage-${context}`;
  return getStore({ name, consistency: "strong" }) as unknown as UsageStore;
}

function corsHeaders(request: Request) {
  const allowList = (env.USAGE_ALLOWED_ORIGIN || "")
    .split(",")
    .map(entry => entry.trim())
    .filter(Boolean);
  const origin = request.headers.get("Origin");

  if (!allowList.length) return { "Access-Control-Allow-Origin": "*" };
  if (origin && allowList.includes(origin)) return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
  return null;
}

function json(body: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

async function loadEntries(store: UsageStore) {
  const { blobs } = await store.list({ prefix: USAGE_KEY_PREFIX });
  const entries: UsageEntry[] = [];
  for (const blob of blobs) {
    const entry = parseUsageKey(blob.key);
    if (entry) entries.push(entry);
  }
  return entries;
}

async function pruneExpired(store: UsageStore, entries: UsageEntry[]) {
  const stale = selectStaleKeys(entries, utcDay(-USAGE_RETENTION_DAYS), MAX_DELETES_PER_RUN);
  if (!stale.length) return 0;
  await Promise.all(stale.map(key => store.delete(key)));
  return stale.length;
}

async function handlePost(request: Request, cors: Record<string, string>) {
  const contentLength = parseInt(request.headers.get("Content-Length") || "0", 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return json({ error: "payload_too_large" }, 413, cors);
  }

  let installId = "";
  try {
    const body = await request.json();
    if (body && typeof body === "object") {
      installId = String((body as Record<string, unknown>).installId ?? "");
    }
  } catch (e) {
    return json({ error: "invalid_body" }, 400, cors);
  }

  if (!USAGE_INSTALL_ID_PATTERN.test(installId)) return json({ error: "invalid_install_id" }, 400, cors);

  const store = usageStore();
  await store.set(usageKey(utcDay(), installId.toLowerCase()), "1");

  // Aufraeumen kostet einen zusaetzlichen list()-Aufruf, deshalb nur selten.
  if (Math.random() < PRUNE_PROBABILITY) {
    try {
      await pruneExpired(store, await loadEntries(store));
    } catch (e) {}
  }

  return new Response(null, { status: 204, headers: cors });
}

async function handleGet(cors: Record<string, string>) {
  const store = usageStore();
  const entries = await loadEntries(store);
  const totals = aggregateUsage(entries, usageWindows());

  // Hier liegt die Liste schon vor, das Aufraeumen ist also fast gratis.
  try {
    await pruneExpired(store, entries);
  } catch (e) {}

  return json({ ...totals, retentionDays: USAGE_RETENTION_DAYS }, 200, {
    ...cors,
    "Cache-Control": "public, max-age=60",
  });
}

export default async (request: Request) => {
  const cors = corsHeaders(request);
  if (!cors) return new Response(null, { status: 403 });

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  try {
    if (request.method === "POST") return await handlePost(request, cors);
    if (request.method === "GET") return await handleGet(cors);
  } catch (e) {
    // Kein Blob-Store erreichbar: 503, damit der Client den Tag offen laesst
    // und es spaeter erneut versucht.
    return json({ error: "counter_unavailable" }, 503, cors);
  }

  return json({ error: "method_not_allowed" }, 405, { ...cors, Allow: "GET, POST, OPTIONS" });
};

export const config = { path: "/api/usage" };
