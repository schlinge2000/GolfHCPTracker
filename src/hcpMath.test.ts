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

// ---------------------------------------------------------------------------
// Vollständiger Datensatz aus "Scoring_Record_Detailliert_Christian_Mießen_
// 20.07.2026.pdf" (15 Runden). Chronologisch, älteste zuerst (golf.de Nr. 15..1).
//
// rawSD      = Score Differential OHNE Anpassungen -> muss calcRawScoreDiff mit
//              dem zum Spielzeitpunkt gültigen Handicap-Index (hcpiBefore)
//              reproduzieren.
// reportedSD = "SD"-Spalte von golf.de, INKLUSIVE aller Anpassungen (PCC, ExSc).
// exsc       = Exceptional-Score-Reduktion (WHS 5.9), die auf reportedSD wirkt.
//
// Die Runde 09.04.2026 (Nr. 11) war ein Exceptional Score (Roh-Differenzial 32.4
// bei Index 45.6 -> 13.2 unter dem Index) und löste eine Reduktion von -2.0 aus,
// die rückwirkend auf alle damals vorhandenen Differenziale angewendet wurde.
// Deshalb tragen die vier ältesten Runden UND Nr. 11 selbst je eine -2.0.
const scoringRecord2026 = [
  { nr: 15, date: "2025-08-30", holes: 18, gbe: 126, courseRating: 70.0, slopeRating: 113, hcpiBefore: 54.0, rawSD: 56.0, reportedSD: 54.0, exsc: -2 },
  { nr: 14, date: "2025-10-11", holes: 9,  gbe: 67,  courseRating: 36.0, slopeRating: 134, hcpiBefore: 54.0, rawSD: 55.4, reportedSD: 53.4, exsc: -2 },
  { nr: 13, date: "2026-03-29", holes: 9,  gbe: 49,  courseRating: 30.1, slopeRating: 100, hcpiBefore: 53.4, rawSD: 50.4, reportedSD: 48.4, exsc: -2 },
  { nr: 12, date: "2026-04-03", holes: 9,  gbe: 48,  courseRating: 30.1, slopeRating: 100, hcpiBefore: 48.4, rawSD: 46.6, reportedSD: 44.6, exsc: -2 },
  { nr: 11, date: "2026-04-09", holes: 18, gbe: 109, courseRating: 71.7, slopeRating: 130, hcpiBefore: 45.6, rawSD: 32.4, reportedSD: 30.4, exsc: -2 },
  { nr: 10, date: "2026-04-22", holes: 18, gbe: 118, courseRating: 71.7, slopeRating: 130, hcpiBefore: 30.4, rawSD: 40.2, reportedSD: 40.2, exsc: 0 },
  { nr: 9,  date: "2026-05-01", holes: 18, gbe: 112, courseRating: 71.7, slopeRating: 130, hcpiBefore: 30.4, rawSD: 35.0, reportedSD: 35.0, exsc: 0 },
  { nr: 8,  date: "2026-05-02", holes: 18, gbe: 106, courseRating: 71.7, slopeRating: 130, hcpiBefore: 30.4, rawSD: 29.8, reportedSD: 29.8, exsc: 0 },
  { nr: 7,  date: "2026-05-10", holes: 18, gbe: 121, courseRating: 71.7, slopeRating: 130, hcpiBefore: 30.1, rawSD: 42.9, reportedSD: 42.9, exsc: 0 },
  { nr: 6,  date: "2026-05-17", holes: 18, gbe: 115, courseRating: 71.7, slopeRating: 130, hcpiBefore: 30.1, rawSD: 37.6, reportedSD: 37.6, exsc: 0 },
  { nr: 5,  date: "2026-06-08", holes: 9,  gbe: 59,  courseRating: 36.0, slopeRating: 134, hcpiBefore: 30.1, rawSD: 36.3, reportedSD: 36.3, exsc: 0 },
  { nr: 4,  date: "2026-06-17", holes: 18, gbe: 121, courseRating: 71.7, slopeRating: 130, hcpiBefore: 30.1, rawSD: 42.9, reportedSD: 42.9, exsc: 0 },
  { nr: 3,  date: "2026-06-28", holes: 18, gbe: 109, courseRating: 71.7, slopeRating: 130, hcpiBefore: 30.1, rawSD: 32.4, reportedSD: 32.4, exsc: 0 },
  { nr: 2,  date: "2026-07-06", holes: 9,  gbe: 53,  courseRating: 36.0, slopeRating: 134, hcpiBefore: 30.1, rawSD: 31.2, reportedSD: 31.2, exsc: 0 },
  { nr: 1,  date: "2026-07-18", holes: 18, gbe: 106, courseRating: 71.7, slopeRating: 130, hcpiBefore: 30.1, rawSD: 29.8, reportedSD: 29.8, exsc: 0 },
];

describe("golf.de scoring record 20.07.2026 – per-round differential (all 15 rounds)", () => {
  it.each(scoringRecord2026)(
    "round #$nr ($date): calcRawScoreDiff reproduces the raw golf.de differential $rawSD",
    ({ holes, gbe, courseRating, slopeRating, hcpiBefore, rawSD }) => {
      expect(
        calcRawScoreDiff({ holes, gbe, courseRating, slopeRating }, hcpiBefore),
      ).toBe(rawSD);
    },
  );

  it.each(scoringRecord2026.filter(r => r.exsc !== 0))(
    "round #$nr ($date): reported SD equals raw SD plus the exceptional-score reduction ($exsc)",
    ({ rawSD, reportedSD, exsc }) => {
      expect(Math.round((rawSD + exsc) * 10) / 10).toBe(reportedSD);
    },
  );
});

describe("golf.de scoring record 20.07.2026 – Handicap Index (base WHS value)", () => {
  // reportedSD-Werte sind das golf.de-Ground-Truth (inkl. PCC/ExSc). Der reine
  // WHS-Wert (Mittel der besten 5 von 15) entspricht golf.de's "Berechneter HCPI".
  const reportedDiffs = scoringRecord2026.map(r => r.reportedSD);

  it("computes the WHS base index (golf.de 'Berechneter HCPI') of 30.7", () => {
    expect(calcHcp(reportedDiffs)).toBe(30.7);
  });

  // Der offizielle golf.de-HCPI ist 30.1. Die Differenz zu 30.7 entsteht durch das
  // Bremse-/Cap-Verfahren (Soft-/Hard-Cap, WHS 5.7/5.8), das an den "Low HCPI" der
  // letzten 365 Tage gebunden ist. Das ist in calcHcp bewusst noch NICHT abgebildet.
  // Sobald die Cap-Logik existiert, sollte hier 30.1 geprüft werden.
  it.todo("applies soft-/hard-cap to reach the official golf.de HCPI of 30.1");
});