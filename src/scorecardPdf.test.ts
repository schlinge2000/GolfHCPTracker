import { describe, expect, it } from "vitest";

import { KAMBACH_SCORECARD_LINES } from "./scorecardPdf.fixture";
import { isUsableScorecard, parseScorecardPdfLines } from "./scorecardPdf";

describe("parseScorecardPdfLines", () => {
  const parsed = parseScorecardPdfLines(KAMBACH_SCORECARD_LINES);

  it("liest Platz, Abschlag und Rating aus der echten Karte", () => {
    expect(parsed.courseName).toBe("Haus Kambach");
    expect(parsed.tee).toBe("gelb");
    expect(parsed.courseRating).toBe(71.7);
    expect(parsed.slopeRating).toBe(130);
    expect(parsed.holeCount).toBe(18);
  });

  it("liest Par und Stroke Index fuer alle 18 Loecher", () => {
    expect(parsed.holes).toHaveLength(18);
    expect(parsed.holes.map(hole => hole.par)).toEqual([5,3,4,5,4,3,4,5,4,4,5,3,5,4,4,4,3,4]);
    expect(parsed.holes.map(hole => hole.si)).toEqual([9,5,15,1,7,13,11,3,17,14,8,10,2,4,6,12,16,18]);
  });

  it("rechnet das Par nach und trifft die Summe der Karte", () => {
    expect(parsed.par).toBe(73);
    expect(parsed.statedPar).toBe(73);
    expect(parsed.warnings).toEqual([]);
    expect(isUsableScorecard(parsed)).toBe(true);
  });

  it("laesst sich von den Score-Spalten nicht stoeren", () => {
    // "0 0" und "OUT 37 - - 0 0 0" duerfen keine Loecher erzeugen.
    expect(parsed.holes.every(hole => hole.nr >= 1 && hole.nr <= 18)).toBe(true);
  });

  it("meldet fehlende Loecher statt sie zu erfinden", () => {
    const short = parseScorecardPdfLines(["Platz", "Testplatz 18 Loch", "1 4 5", "2 3 7"]);
    expect(short.holes).toHaveLength(2);
    expect(short.warnings).toContain("holes-incomplete");
    expect(isUsableScorecard(short)).toBe(false);
  });

  it("meldet doppelte Stroke Indizes", () => {
    const lines = ["Platz", "Neun 9 Loch", ...Array.from({length:9},(_,i)=>`${i+1} 4 3`)];
    const nine = parseScorecardPdfLines(lines);
    expect(nine.holeCount).toBe(9);
    expect(nine.holes).toHaveLength(9);
    expect(nine.warnings).toContain("si-not-unique");
  });

  it("meldet, wenn Course Rating und Slope fehlen", () => {
    const lines = ["Platz", "Ohne Rating 18 Loch", ...Array.from({length:18},(_,i)=>`${i+1} 4 ${i+1}`)];
    expect(parseScorecardPdfLines(lines).warnings).toContain("rating-missing");
  });

  it("meldet eine abweichende Par-Summe der Karte", () => {
    const lines = [...Array.from({length:18},(_,i)=>`${i+1} 4 ${i+1}`), "1-18 71 - -"];
    const parsedMismatch = parseScorecardPdfLines(lines);
    expect(parsedMismatch.par).toBe(72);
    expect(parsedMismatch.statedPar).toBe(71);
    expect(parsedMismatch.warnings).toContain("par-mismatch");
  });
});
