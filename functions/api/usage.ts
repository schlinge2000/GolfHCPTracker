/**
 * Anonymer Nutzungszaehler (Cloudflare Pages Function + D1).
 *
 * POST /api/usage  -> merkt sich "diese Installations-ID war heute aktiv"
 * GET  /api/usage  -> aggregierte Zahlen (heute / 7 Tage / 30 Tage / gesamt)
 *
 * Bewusst nicht gespeichert: IP-Adresse, User-Agent, Referrer, Zeitstempel
 * feiner als der Kalendertag. Es werden keine Cookies gesetzt. Gespeichert
 * wird ausschliesslich das Paar (Installations-ID, Tag), und das nur fuer
 * RETENTION_DAYS Tage.
 *
 * Die Datei wird nicht von `tsc -b` erfasst (tsconfig.app.json: include ["src"]),
 * die D1-Typen sind daher lokal minimal beschrieben.
 */

type D1Result<T = unknown> = { results?: T[]; meta?: { changes?: number } };

type D1PreparedStatement = {
  bind: (...values: unknown[]) => D1PreparedStatement;
  run: () => Promise<D1Result>;
  first: <T = Record<string, unknown>>() => Promise<T | null>;
};

type D1Database = {
  prepare: (query: string) => D1PreparedStatement;
};

type UsageEnv = {
  /** D1-Binding, siehe docs/usage-counter.md */
  USAGE_DB?: D1Database;
  /** Optional: Komma-Liste erlaubter Origins. Leer = alle erlaubt. */
  USAGE_ALLOWED_ORIGIN?: string;
};

type PagesContext = {
  request: Request;
  env: UsageEnv;
};

const INSTALL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RETENTION_DAYS = 400;
const PRUNE_PROBABILITY = 0.02;
const MAX_BODY_BYTES = 512;

function utcDay(offsetDays = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function corsHeaders(env: UsageEnv, request: Request) {
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

export async function onRequestOptions(context: PagesContext) {
  const cors = corsHeaders(context.env, context.request);
  if (!cors) return new Response(null, { status: 403 });
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

export async function onRequestPost(context: PagesContext) {
  const { request, env } = context;
  const cors = corsHeaders(env, request);
  if (!cors) return new Response(null, { status: 403 });
  if (!env.USAGE_DB) return json({ error: "counter_unavailable" }, 503, cors);

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

  if (!INSTALL_ID_PATTERN.test(installId)) return json({ error: "invalid_install_id" }, 400, cors);

  // Der Tag kommt vom Server, nicht vom Client: das haelt die Tagesbuckets
  // konsistent und verhindert, dass jemand beliebig viele Tage "nachtraegt".
  const day = utcDay();

  try {
    await env.USAGE_DB
      .prepare("INSERT OR IGNORE INTO usage_pings (install_id, day) VALUES (?, ?)")
      .bind(installId.toLowerCase(), day)
      .run();

    if (Math.random() < PRUNE_PROBABILITY) {
      await env.USAGE_DB
        .prepare("DELETE FROM usage_pings WHERE day < ?")
        .bind(utcDay(-RETENTION_DAYS))
        .run();
    }
  } catch (e) {
    return json({ error: "counter_write_failed" }, 500, cors);
  }

  return new Response(null, { status: 204, headers: cors });
}

export async function onRequestGet(context: PagesContext) {
  const { request, env } = context;
  const cors = corsHeaders(env, request);
  if (!cors) return new Response(null, { status: 403 });
  if (!env.USAGE_DB) return json({ error: "counter_unavailable" }, 503, cors);

  try {
    const row = await env.USAGE_DB
      .prepare(
        `SELECT
           COUNT(DISTINCT CASE WHEN day = ? THEN install_id END) AS active_today,
           COUNT(DISTINCT CASE WHEN day >= ? THEN install_id END) AS active_7,
           COUNT(DISTINCT CASE WHEN day >= ? THEN install_id END) AS active_30,
           COUNT(DISTINCT install_id) AS total
         FROM usage_pings`,
      )
      .bind(utcDay(), utcDay(-6), utcDay(-29))
      .first<Record<string, number>>();

    return json(
      {
        activeToday: row?.active_today ?? 0,
        activeLast7Days: row?.active_7 ?? 0,
        activeLast30Days: row?.active_30 ?? 0,
        total: row?.total ?? 0,
        retentionDays: RETENTION_DAYS,
      },
      200,
      { ...cors, "Cache-Control": "public, max-age=60" },
    );
  } catch (e) {
    return json({ error: "counter_read_failed" }, 500, cors);
  }
}
