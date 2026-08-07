import { describe, expect, it } from "vitest";

import {
  createInstallId,
  isValidDay,
  isValidInstallId,
  normalizeUsageState,
  shouldSendPing,
  toDayString,
  usageStateAfterToggle,
} from "./usagePing";

describe("toDayString", () => {
  it("formatiert den lokalen Kalendertag mit fuehrenden Nullen", () => {
    expect(toDayString(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(toDayString(new Date(2026, 11, 31, 0, 1))).toBe("2026-12-31");
  });
});

describe("createInstallId", () => {
  it("erzeugt eine gueltige, nicht wiederholte UUID", () => {
    const first = createInstallId();
    const second = createInstallId();
    expect(isValidInstallId(first)).toBe(true);
    expect(isValidInstallId(second)).toBe(true);
    expect(first).not.toBe(second);
  });
});

describe("isValidInstallId", () => {
  it("akzeptiert nur UUID-Form", () => {
    expect(isValidInstallId("3f2a1c4e-5b6d-4e8f-9a0b-1c2d3e4f5a6b")).toBe(true);
    expect(isValidInstallId("nicht-uuid")).toBe(false);
    expect(isValidInstallId("")).toBe(false);
    expect(isValidInstallId(undefined)).toBe(false);
    expect(isValidInstallId(42)).toBe(false);
  });
});

describe("isValidDay", () => {
  it("akzeptiert nur YYYY-MM-DD", () => {
    expect(isValidDay("2026-08-07")).toBe(true);
    expect(isValidDay("2026-8-7")).toBe(false);
    expect(isValidDay(null)).toBe(false);
  });
});

describe("normalizeUsageState", () => {
  it("ist ohne gespeicherten Stand aktiv, aber noch ohne ID", () => {
    expect(normalizeUsageState(null)).toEqual({ enabled: true, installId: "", lastSentDay: "" });
  });

  it("uebernimmt gueltige Werte", () => {
    const state = normalizeUsageState({
      enabled: true,
      installId: "3f2a1c4e-5b6d-4e8f-9a0b-1c2d3e4f5a6b",
      lastSentDay: "2026-08-07",
    });
    expect(state).toEqual({
      enabled: true,
      installId: "3f2a1c4e-5b6d-4e8f-9a0b-1c2d3e4f5a6b",
      lastSentDay: "2026-08-07",
    });
  });

  it("verwirft kaputte Werte statt sie zu senden", () => {
    const state = normalizeUsageState({ enabled: true, installId: "<script>", lastSentDay: "gestern" });
    expect(state.installId).toBe("");
    expect(state.lastSentDay).toBe("");
  });

  it("haelt bei Opt-out keine ID vor", () => {
    const state = normalizeUsageState({ enabled: false, installId: "3f2a1c4e-5b6d-4e8f-9a0b-1c2d3e4f5a6b" });
    expect(state.enabled).toBe(false);
    expect(state.installId).toBe("");
  });
});

describe("shouldSendPing", () => {
  const base = { enabled: true, installId: "3f2a1c4e-5b6d-4e8f-9a0b-1c2d3e4f5a6b", lastSentDay: "2026-08-06" };

  it("sendet einmal pro Tag", () => {
    expect(shouldSendPing(base, "2026-08-07")).toBe(true);
    expect(shouldSendPing({ ...base, lastSentDay: "2026-08-07" }, "2026-08-07")).toBe(false);
  });

  it("sendet nie bei Opt-out", () => {
    expect(shouldSendPing({ ...base, enabled: false }, "2026-08-07")).toBe(false);
  });

  it("sendet auch, wenn der letzte Versuch offen geblieben ist", () => {
    // Ein fehlgeschlagener Ping laesst lastSentDay unveraendert -> naechster Start versucht es erneut.
    expect(shouldSendPing({ ...base, lastSentDay: "" }, "2026-08-07")).toBe(true);
  });
});

describe("usageStateAfterToggle", () => {
  const active = { enabled: true, installId: "3f2a1c4e-5b6d-4e8f-9a0b-1c2d3e4f5a6b", lastSentDay: "2026-08-07" };

  it("loescht beim Abschalten ID und Verlauf", () => {
    expect(usageStateAfterToggle(active, false)).toEqual({ enabled: false, installId: "", lastSentDay: "" });
  });

  it("startet nach dem Wiedereinschalten ohne alte ID", () => {
    const off = usageStateAfterToggle(active, false);
    const on = usageStateAfterToggle(off, true);
    expect(on.enabled).toBe(true);
    expect(on.installId).toBe("");
    expect(on.lastSentDay).toBe("");
  });
});
