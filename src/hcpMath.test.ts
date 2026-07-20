import { describe, expect, it } from "vitest";

import { calcHcp, calcRawScoreDiff, calcScoreDiff, getHandicapRule } from "./hcpMath";

const pdfSampleRounds = [
  {
    label: "Pulheim 03.04.2026",
    hi: 48.4,
    holes: 9,
    gross: 48,
    courseRating: 30.1,
    slopeRating: 100,
    reportedDiff: 46.6,
  },
  {
    label: "Pulheim 29.03.2026",
    hi: 53.4,
    holes: 9,
    gross: 49,
    courseRating: 30.1,
    slopeRating: 100,
    reportedDiff: 50.4,
  },
  {
    label: "Kambach 11.10.2025",
    hi: 54.0,
    holes: 9,
    gross: 67,
    courseRating: 36,
    slopeRating: 134,
    reportedDiff: 55.4,
  },
  {
    label: "Kambach 30.08.2025",
    hi: 54.0,
    holes: 18,
    gross: 126,
    courseRating: 70,
    slopeRating: 113,
    reportedDiff: 56.0,
  },
  {
    label: "Pulheim 03.04.2026 (Hans-Juergen)",
    hi: 50.9,
    holes: 9,
    gross: 48,
    courseRating: 30.1,
    slopeRating: 100,
    reportedDiff: 47.9,
  },
  {
    label: "Pulheim 29.03.2026 (Hans-Juergen)",
    hi: 54.0,
    holes: 9,
    gross: 51,
    courseRating: 30.1,
    slopeRating: 100,
    reportedDiff: 52.9,
  },
];

describe("golf.de PDF differential handling", () => {
  it("uses the reported golf.de differential when present", () => {
    expect(
      calcScoreDiff(
        {
          source: "golf.de-pdf",
          holes: 9,
          gbe: 48,
          courseRating: 30.1,
          slopeRating: 100,
          reportedDiff: 46.6,
        },
        48.4,
      ),
    ).toBe(46.6);
  });

  it("matches the 18-hole PDF sample using the raw formula", () => {
    expect(
      calcRawScoreDiff(
        {
          holes: 18,
          gbe: 126,
          courseRating: 70,
          slopeRating: 113,
        },
        54,
      ),
    ).toBe(56.0);
  });
});

describe("9-hole raw differential calculation against PDF samples", () => {
  it.each(pdfSampleRounds.filter(round => round.holes === 9))(
    "matches the PDF-reported differential for $label",
    ({ hi, holes, gross, courseRating, slopeRating, reportedDiff }) => {
      expect(
        calcRawScoreDiff(
          {
            holes,
            gbe: gross,
            courseRating,
            slopeRating,
          },
          hi,
        ),
      ).toBe(reportedDiff);
    },
  );
});

describe("WHS Handicap-Index adjustment table", () => {
  // Offizielle WHS-Tabelle: Anpassung wird EINMAL auf den Mittelwert der besten
  // Differenziale addiert.
  it.each([
    { count: 1, take: 1, adj: -2 },
    { count: 2, take: 1, adj: -2 },
    { count: 3, take: 1, adj: -2 },
    { count: 4, take: 1, adj: -1 },
    { count: 5, take: 1, adj: 0 },
    { count: 6, take: 2, adj: -1 },
    { count: 7, take: 2, adj: 0 },
    { count: 8, take: 2, adj: 0 },
    { count: 9, take: 3, adj: 0 },
    { count: 11, take: 3, adj: 0 },
    { count: 20, take: 8, adj: 0 },
  ])("uses take=$take / adj=$adj for $count scores", ({ count, take, adj }) => {
    const rule = getHandicapRule(count);
    expect(rule.take).toBe(take);
    expect(rule.adj).toBe(adj);
  });

  it("applies the -2 adjustment to the average, not to each differential", () => {
    // Zwei zählende Differenziale (6 Runden -> beste 2, Anpassung -1):
    // Ø(20,22) = 21, 21 - 1 = 20. Würde die -1 an jedem SD kleben, käme 19 heraus.
    const diffs = [20, 22, 30, 31, 32, 33];
    expect(calcHcp(diffs)).toBe(20);
  });
});

describe("reconstructs the golf.de HCPI progression (Christian Mießen)", () => {
  // Score Differentials in chronologischer Reihenfolge aus dem golf.de-Report.
  const chronologicalDiffs = [56.0, 55.4, 50.4, 46.6];
  // Vom golf.de-Report abgelesene Handicap-Index-Werte nach n Runden.
  const golfDeHcpi = [54.0, 53.4, 48.4, 45.6];

  it.each(golfDeHcpi.map((hcpi, index) => ({ n: index + 1, hcpi })))(
    "matches golf.de HCPI $hcpi after $n scores",
    ({ n, hcpi }) => {
      expect(calcHcp(chronologicalDiffs.slice(0, n))).toBe(hcpi);
    },
  );
});