import { describe, expect, it } from "vitest";

import { GOLFDE_REPORT_LINES } from "./golfDeReport.fixture";
import { parseGolfDeDetailedReport } from "./golfDeReport";
import { buildIndexTimeline } from "./hcpMath";

describe("parseGolfDeDetailedReport", () => {
  const rounds = parseGolfDeDetailedReport(GOLFDE_REPORT_LINES.join("\n"));

  it("liest alle 20 Runden, neueste zuerst", () => {
    expect(rounds).toHaveLength(20);
    expect(rounds.map(round => round.sourceRoundId)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(rounds[0].date).toBe("2026-10-12");
    expect(rounds[19].date).toBe("2026-07-06");
  });

  it("liest bei jeder Runde den HCPI davor aus ihrer eigenen Zeile", () => {
    expect(rounds.map(round => round.handicapIndexBefore)).toEqual([
      24.0, 24.0, 24.4, 24.7, 24.8, 25.1, 25.6, 25.6, 26.5, 26.9,
      27.6, 28.9, 28.9, 28.9, 29.4, 29.8, 31.8, 32.2, 32.8, 33.9,
    ]);
  });

  it("nimmt fuer die letzte Runde nichts aus der Legende darunter", () => {
    const last = rounds[19];
    expect(last.holes).toBe(9);
    expect(last.handicapIndexBefore).toBe(33.9); // nicht die 18 aus "(auf 18 Loecher)"
    expect(last.playingHcp).toBe(39);
    expect(last.pcc).toBe(0);
    expect(last.gbe).toBe(50);
  });

  it("laesst eine spaeter wiederholte Angabe die der Runde nicht ueberschreiben", () => {
    const [round] = parseGolfDeDetailedReport([
      "1 06.07.2026 4473 Monatspreis 9 S 50 29.6",
      "Club: Golfclub Haus Kambach Country: 49 Rd.: 1 PCC: 0",
      "Tees: gelb Par: 37 CR: 36 Slope: 134 HCPI: 33,9 CH: 39 ExSc: 0",
      "Berechneter HCPI: Handicap-Index (auf 18 Loecher)",
    ].join("\n"));
    expect(round.handicapIndexBefore).toBe(33.9);
  });

  it("kommt aus dem Import auf jedes SD und den HCPI von golf.de (24,0)", () => {
    const steps = buildIndexTimeline([...rounds].reverse(), 54);
    expect(steps.map(step => step.diff)).toEqual(steps.map(step => step.round.reportedDiff));
    expect(steps[steps.length - 1].hcpAfter).toBe(24.0);
  });
});
