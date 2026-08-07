/**
 * Testet die Zaehl-Function gegen einen In-Memory-Ersatz von Netlify Blobs.
 *
 * Liegt bewusst hier und nicht in netlify/functions/: Netlify bundelt jede
 * Datei in diesem Verzeichnis als eigene Function und scheitert dann an der
 * Testdatei.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { usageKey, USAGE_RETENTION_DAYS, utcDay } from "./usageAggregate";

const { blobs } = vi.hoisted(() => ({ blobs: new Map<string, string>() }));

vi.mock("@netlify/blobs", () => ({
  getStore: () => ({
    set: async (key: string, value: string) => {
      blobs.set(key, value);
    },
    delete: async (key: string) => {
      blobs.delete(key);
    },
    list: async ({ prefix }: { prefix: string }) => ({
      blobs: [...blobs.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key, etag: "x" })),
      directories: [],
    }),
  }),
}));

const handler = (await import("../netlify/functions/usage.mts")).default;

/** Dieselbe Referenz, die die Function liest - ohne @types/node vorauszusetzen. */
const testEnv = (globalThis as any).process.env as Record<string, string | undefined>;

const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const post = (body: unknown, headers: Record<string, string> = {}) =>
  handler(
    new Request("https://example.test/api/usage", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

const get = (headers: Record<string, string> = {}) =>
  handler(new Request("https://example.test/api/usage", { method: "GET", headers }));

beforeEach(() => {
  blobs.clear();
  delete testEnv.USAGE_ALLOWED_ORIGIN;
});

describe("POST /api/usage", () => {
  it("legt genau einen Schluessel pro ID und Tag an", async () => {
    const response = await post({ installId: ID_A });
    expect(response.status).toBe(204);
    expect([...blobs.keys()]).toEqual([usageKey(utcDay(), ID_A)]);
  });

  it("zaehlt denselben Ping am selben Tag nicht doppelt", async () => {
    await post({ installId: ID_A });
    await post({ installId: ID_A });
    await post({ installId: ID_A.toUpperCase() });
    expect(blobs.size).toBe(1);
  });

  it("weist ungueltige IDs ab, ohne zu schreiben", async () => {
    for (const installId of ["", "kein-uuid", "../../etc/passwd", "a".repeat(200)]) {
      const response = await post({ installId });
      expect(response.status).toBe(400);
    }
    expect(blobs.size).toBe(0);
  });

  it("weist kaputtes JSON ab", async () => {
    const response = await post("{nicht json");
    expect(response.status).toBe(400);
    expect(blobs.size).toBe(0);
  });

  it("weist zu grosse Bodies ab", async () => {
    const response = await post({ installId: ID_A }, { "Content-Length": "99999" });
    expect(response.status).toBe(413);
    expect(blobs.size).toBe(0);
  });

  it("speichert ausser dem Schluessel keine Nutzdaten", async () => {
    await post({ installId: ID_A, name: "Christian", hcp: 22.4, userAgent: "Safari" });
    expect([...blobs.keys()]).toEqual([usageKey(utcDay(), ID_A)]);
    expect([...blobs.values()]).toEqual(["1"]);
  });
});

describe("GET /api/usage", () => {
  it("liefert die Aggregate ueber alle Fenster", async () => {
    blobs.set(usageKey(utcDay(), ID_A), "1");
    blobs.set(usageKey(utcDay(), ID_B), "1");
    blobs.set(usageKey(utcDay(-3), ID_B), "1");
    blobs.set(usageKey(utcDay(-10), "cccccccc-cccc-4ccc-8ccc-cccccccccccc"), "1");

    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      activeToday: 2,
      activeLast7Days: 2,
      activeLast30Days: 3,
      total: 3,
      retentionDays: USAGE_RETENTION_DAYS,
    });
  });

  it("ist ohne Eintraege bei null", async () => {
    expect(await (await get()).json()).toMatchObject({ activeToday: 0, total: 0 });
  });

  it("raeumt abgelaufene Zeilen weg", async () => {
    const expired = usageKey(utcDay(-(USAGE_RETENTION_DAYS + 5)), ID_B);
    blobs.set(usageKey(utcDay(), ID_A), "1");
    blobs.set(expired, "1");

    const totals = await (await get()).json();
    expect(totals.total).toBe(1);
    expect(blobs.has(expired)).toBe(false);
    expect(blobs.has(usageKey(utcDay(), ID_A))).toBe(true);
  });

  it("ignoriert fremde Schluessel im Store", async () => {
    blobs.set("etwas/anderes", "1");
    blobs.set(usageKey(utcDay(), ID_A), "1");
    expect(await (await get()).json()).toMatchObject({ total: 1 });
  });
});

describe("Methoden und CORS", () => {
  it("antwortet auf OPTIONS mit den erlaubten Methoden", async () => {
    const response = await handler(new Request("https://example.test/api/usage", { method: "OPTIONS" }));
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("lehnt andere Methoden ab", async () => {
    const response = await handler(new Request("https://example.test/api/usage", { method: "DELETE" }));
    expect(response.status).toBe(405);
  });

  it("erlaubt ohne Allowlist jeden Origin", async () => {
    expect((await get()).headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("beschraenkt auf die konfigurierte Allowlist", async () => {
    testEnv.USAGE_ALLOWED_ORIGIN = "https://golf.example.com, https://zweite.example.com";

    const allowed = await get({ Origin: "https://zweite.example.com" });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("https://zweite.example.com");

    const blocked = await post({ installId: ID_A }, { Origin: "https://boeser.example.com" });
    expect(blocked.status).toBe(403);
    expect(blobs.size).toBe(0);
  });
});
