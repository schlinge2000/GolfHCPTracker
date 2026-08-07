import { describe, expect, it } from "vitest";

import {
  aggregateUsage,
  parseUsageKey,
  selectStaleKeys,
  usageKey,
  usageWindows,
  USAGE_RETENTION_DAYS,
  utcDay,
} from "./usageAggregate";

const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ID_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = new Date("2026-08-07T12:00:00Z");

const entry = (day: string, installId: string) => parseUsageKey(usageKey(day, installId))!;

describe("utcDay", () => {
  it("rechnet in UTC und mit Tagesversatz", () => {
    expect(utcDay(0, NOW)).toBe("2026-08-07");
    expect(utcDay(-6, NOW)).toBe("2026-08-01");
    expect(utcDay(-29, NOW)).toBe("2026-07-09");
  });

  it("rechnet ueber Monats- und Jahresgrenzen", () => {
    expect(utcDay(-1, new Date("2026-01-01T00:30:00Z"))).toBe("2025-12-31");
    expect(utcDay(-1, new Date("2026-03-01T00:30:00Z"))).toBe("2026-02-28");
  });

  it("veraendert das uebergebene Datum nicht", () => {
    const now = new Date("2026-08-07T12:00:00Z");
    utcDay(-400, now);
    expect(now.toISOString()).toBe("2026-08-07T12:00:00.000Z");
  });
});

describe("parseUsageKey", () => {
  it("liest Tag und ID aus dem Schluessel", () => {
    expect(parseUsageKey(`pings/2026-08-07/${ID_A}`)).toEqual({
      key: `pings/2026-08-07/${ID_A}`,
      day: "2026-08-07",
      installId: ID_A,
    });
  });

  it("ignoriert fremde oder kaputte Schluessel", () => {
    expect(parseUsageKey("andere/2026-08-07/x")).toBeNull();
    expect(parseUsageKey(`pings/07.08.2026/${ID_A}`)).toBeNull();
    expect(parseUsageKey("pings/2026-08-07/kein-uuid")).toBeNull();
    expect(parseUsageKey("pings/2026-08-07/")).toBeNull();
    expect(parseUsageKey(`pings/${ID_A}`)).toBeNull();
    expect(parseUsageKey("")).toBeNull();
  });
});

describe("aggregateUsage", () => {
  const windows = usageWindows(NOW);

  it("zaehlt jede ID pro Fenster nur einmal", () => {
    const totals = aggregateUsage(
      [
        entry("2026-08-07", ID_A), // heute
        entry("2026-08-07", ID_B), // heute
        entry("2026-08-04", ID_B), // dieselbe ID an einem zweiten Tag
        entry("2026-07-28", ID_C), // nur im 30-Tage-Fenster
      ],
      windows,
    );
    expect(totals).toEqual({ activeToday: 2, activeLast7Days: 2, activeLast30Days: 3, total: 3 });
  });

  it("laesst abgelaufene Zeilen aus allen Zahlen heraus", () => {
    const expired = utcDay(-(USAGE_RETENTION_DAYS + 1), NOW);
    const totals = aggregateUsage([entry("2026-08-07", ID_A), entry(expired, ID_B)], windows);
    expect(totals).toEqual({ activeToday: 1, activeLast7Days: 1, activeLast30Days: 1, total: 1 });
  });

  it("zaehlt den Fensterrand mit", () => {
    const totals = aggregateUsage([entry(windows.since7, ID_A), entry(windows.since30, ID_B)], windows);
    expect(totals.activeLast7Days).toBe(1);
    expect(totals.activeLast30Days).toBe(2);
  });

  it("liefert Nullen ohne Eintraege", () => {
    expect(aggregateUsage([], windows)).toEqual({
      activeToday: 0,
      activeLast7Days: 0,
      activeLast30Days: 0,
      total: 0,
    });
  });
});

describe("selectStaleKeys", () => {
  it("waehlt nur Zeilen vor dem Stichtag", () => {
    const stale = selectStaleKeys(
      [entry("2026-08-07", ID_A), entry("2020-01-01", ID_B), entry("2019-05-05", ID_C)],
      "2025-01-01",
      500,
    );
    expect(stale).toEqual([usageKey("2020-01-01", ID_B), usageKey("2019-05-05", ID_C)]);
  });

  it("begrenzt die Menge pro Aufruf", () => {
    const entries = Array.from({ length: 20 }, (_, i) =>
      entry(`2019-01-${String(i + 1).padStart(2, "0")}`, ID_A),
    );
    expect(selectStaleKeys(entries, "2025-01-01", 5)).toHaveLength(5);
  });
});
