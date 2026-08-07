import { describe, expect, it } from "vitest";

import {
  applyBeginnerRetention,
  BEGINNER_RETENTION_MAX,
  buildIndexTimeline,
  calcHcp,
  calcRawScoreDiff,
  calcScoreDiff,
  exceptionalScoreReduction,
  getHandicapRule,
} from "./hcpMath";

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
});

// Bildet buildHandicapTimeline nach: chronologisch je Runde den WHS-Grundwert
// berechnen und die DGV-Anfängerregel anwenden.
function replayWithRetention(chronologicalDiffs: number[], startHcp = 54): number {
  let current = Math.min(54, startHcp);
  const acc: number[] = [];
  for (const diff of chronologicalDiffs) {
    acc.push(diff);
    const base = calcHcp(acc);
    if (base !== null) current = applyBeginnerRetention(base, current);
  }
  return current;
}

describe("DGV beginner retention rule (applyBeginnerRetention)", () => {
  it("keeps a once-achieved index above 26.9 from rising again", () => {
    expect(applyBeginnerRetention(31.7, 30.1)).toBe(30.1);
  });

  it("always allows the index to improve (drop)", () => {
    expect(applyBeginnerRetention(28.0, 30.1)).toBe(28.0);
  });

  it("does not block a rise once the index is 26.9 or better", () => {
    // previousHcp = 26.9 liegt nicht ÜBER der Schwelle -> normale Bewegung.
    expect(applyBeginnerRetention(28.0, BEGINNER_RETENTION_MAX)).toBe(28.0);
    expect(applyBeginnerRetention(27.5, 26.5)).toBe(27.5);
  });
});

describe("golf.de scoring record 20.07.2026 – official HCPI with beginner retention", () => {
  const reportedDiffs = scoringRecord2026.map(r => r.reportedSD);

  it("reaches the official golf.de HCPI of 30.1 (brake held after the exceptional 109)", () => {
    expect(replayWithRetention(reportedDiffs)).toBe(30.1);
  });

  // Ab Runde 11 (der 109) sind die gespeicherten Differenziale stabil, daher matcht
  // die geführte Progression golf.de exakt. Die vier ältesten Zwischenwerte weichen
  // ab, weil dort die Exceptional-Score-Reduktion bereits im gespeicherten
  // Differenzial steckt (bekannte Grenze des reinen Replays mit End-Differenzialen).
  it("matches golf.de's official index from the exceptional round onward", () => {
    const golfDeAfter = [30.4, 30.4, 30.4, 30.1, 30.1, 30.1, 30.1, 30.1, 30.1, 30.1, 30.1];
    const fromRound11 = reportedDiffs.slice(0, 5); // R15..R11
    const rest = reportedDiffs.slice(5); // R10..R1
    let current = replayWithRetention(fromRound11);
    const acc = [...fromRound11];
    const progression: number[] = [];
    for (const diff of rest) {
      acc.push(diff);
      const base = calcHcp(acc)!;
      current = applyBeginnerRetention(base, current);
      progression.push(current);
    }
    // current nach R11 selbst + Fortschreibung R10..R1
    expect([replayWithRetention(fromRound11), ...progression]).toEqual(golfDeAfter);
  });
});

describe("exceptional score reduction (WHS 5.9)", () => {
  it.each([
    { prev: 45.6, raw: 32.4, expected: 2.0 }, // 13.2 darunter -> -2.0 (die 109)
    { prev: 30.1, raw: 22.5, expected: 1.0 }, // 7.6 darunter -> -1.0
    { prev: 30.1, raw: 20.1, expected: 2.0 }, // 10.0 darunter -> -2.0
    { prev: 30.1, raw: 24.0, expected: 0 },   // 6.1 darunter -> keine Reduktion
    { prev: 30.1, raw: 29.8, expected: 0 },
  ])("prev $prev, raw $raw -> reduction $expected", ({ prev, raw, expected }) => {
    expect(exceptionalScoreReduction(prev, raw)).toBe(expected);
  });
});

describe("buildIndexTimeline reproduces the full golf.de progression (all 15 rounds)", () => {
  // Vollständige chronologische Engine: Rohdifferenzial -> Exceptional Score
  // (zum Ereigniszeitpunkt) -> Bremse. Muss golf.de Runde für Runde treffen.
  const golfDeAfter = [54.0, 53.4, 48.4, 45.6, 30.4, 30.4, 30.4, 30.1, 30.1, 30.1, 30.1, 30.1, 30.1, 30.1, 30.1];

  const steps = buildIndexTimeline(scoringRecord2026, 54);

  it("keeps every round (none dropped)", () => {
    expect(steps).toHaveLength(scoringRecord2026.length);
  });

  it.each(scoringRecord2026.map((r, i) => ({ nr: r.nr, i, before: r.hcpiBefore })))(
    "round #$nr: index before the round matches golf.de ($before)",
    ({ i, before }) => {
      expect(steps[i].preRoundHcp).toBe(before);
    },
  );

  it.each(scoringRecord2026.map((r, i) => ({ nr: r.nr, i, after: golfDeAfter[i] })))(
    "round #$nr: index after the round matches golf.de ($after)",
    ({ i, after }) => {
      expect(steps[i].hcpAfter).toBe(after);
    },
  );

  it.each(scoringRecord2026.map((r, i) => ({ nr: r.nr, i, sd: r.reportedSD })))(
    "round #$nr: final differential matches golf.de SD ($sd, incl. exceptional-score reduction)",
    ({ i, sd }) => {
      expect(steps[i].diff).toBe(sd);
    },
  );

  it("ends at the official golf.de HCPI of 30.1", () => {
    expect(steps[steps.length - 1].hcpAfter).toBe(30.1);
  });

  it("respects chronology: the -2 hits only from the exceptional round onward, not the raw values before it", () => {
    // Rohdifferenziale bleiben unangetastet; erst das Fenster wird reduziert.
    expect(steps[0].rawDiff).toBe(56.0); // Platzreife roh
    expect(steps[0].diff).toBe(54.0);    // final nach -2 (durch die spätere 109)
    expect(steps[4].rawDiff).toBe(32.4); // die 109 roh
    expect(steps[4].diff).toBe(30.4);    // final nach eigener -2
  });
});

// Vollständiger golf.de-Import "Hans-Jürgen Juretzek 07.08.2026" (20 Runden),
// chronologisch älteste zuerst. Enthält genau einen Exceptional Score:
// Runde vom 26.07.2026 (Index davor 31,8; Roh-Differenzial 24,6 -> 7,2 Schläge
// darunter -> -1,0), der die betroffene Runde von 24,6 auf 23,6 senkt.
// Wichtig: source + handicapIndexBefore markieren echte golf.de-Importe, für die
// die Engine den von golf.de geführten HCPI-davor als Anker nutzt.
const hjImport2026 = [
  { nr: 20, holes: 9,  gbe: 51,  courseRating: 30.1, slopeRating: 100, handicapIndexBefore: 54.0, reportedSD: 51.9 },
  { nr: 19, holes: 9,  gbe: 48,  courseRating: 30.1, slopeRating: 100, handicapIndexBefore: 50.9, reportedSD: 46.9 },
  { nr: 18, holes: 18, gbe: 121, courseRating: 71.7, slopeRating: 130, handicapIndexBefore: 45.9, reportedSD: 41.9 },
  { nr: 17, holes: 9,  gbe: 55,  courseRating: 34.5, slopeRating: 125, handicapIndexBefore: 41.9, reportedSD: 40.5 },
  { nr: 16, holes: 18, gbe: 110, courseRating: 69.0, slopeRating: 124, handicapIndexBefore: 41.5, reportedSD: 36.4 },
  { nr: 15, holes: 18, gbe: 118, courseRating: 71.7, slopeRating: 130, handicapIndexBefore: 38.5, reportedSD: 39.2 },
  { nr: 14, holes: 18, gbe: 108, courseRating: 71.7, slopeRating: 130, handicapIndexBefore: 38.5, reportedSD: 30.6 },
  { nr: 13, holes: 18, gbe: 113, courseRating: 71.7, slopeRating: 130, handicapIndexBefore: 34.5, reportedSD: 34.9 },
  { nr: 12, holes: 9,  gbe: 61,  courseRating: 37.8, slopeRating: 129, handicapIndexBefore: 34.5, reportedSD: 38.4 },
  { nr: 11, holes: 9,  gbe: 66,  courseRating: 37.8, slopeRating: 129, handicapIndexBefore: 34.5, reportedSD: 42.8 },
  { nr: 10, holes: 9,  gbe: 55,  courseRating: 36.0, slopeRating: 134, handicapIndexBefore: 34.5, reportedSD: 34.1 },
  { nr: 9,  holes: 18, gbe: 120, courseRating: 71.7, slopeRating: 130, handicapIndexBefore: 34.5, reportedSD: 41.0 },
  { nr: 8,  holes: 9,  gbe: 53,  courseRating: 36.0, slopeRating: 134, handicapIndexBefore: 34.5, reportedSD: 32.4 },
  { nr: 7,  holes: 18, gbe: 110, courseRating: 71.7, slopeRating: 130, handicapIndexBefore: 34.0, reportedSD: 32.3 },
  { nr: 6,  holes: 9,  gbe: 50,  courseRating: 36.0, slopeRating: 134, handicapIndexBefore: 33.9, reportedSD: 29.6 },
  { nr: 5,  holes: 18, gbe: 105, courseRating: 71.7, slopeRating: 130, handicapIndexBefore: 32.8, reportedSD: 27.9 },
  { nr: 4,  holes: 9,  gbe: 54,  courseRating: 36.0, slopeRating: 134, handicapIndexBefore: 32.2, reportedSD: 32.1 },
  { nr: 3,  holes: 18, gbe: 100, courseRating: 71.7, slopeRating: 130, handicapIndexBefore: 31.8, reportedSD: 23.6 },
  { nr: 2,  holes: 18, gbe: 102, courseRating: 71.7, slopeRating: 130, handicapIndexBefore: 29.8, reportedSD: 26.3 },
  { nr: 1,  holes: 9,  gbe: 52,  courseRating: 37.8, slopeRating: 129, handicapIndexBefore: 29.4, reportedSD: 28.9 },
].map(r => ({ ...r, source: "golf.de-pdf" }));

describe("golf.de import with an exceptional score (Hans-Jürgen 07.08.2026)", () => {
  const steps = buildIndexTimeline(hjImport2026, 54);

  it("derives (not copies) every SD equal to golf.de – incl. the exceptional round 24.6 -> 23.6", () => {
    steps.forEach((step, i) => {
      expect(step.diff).toBe(hjImport2026[i].reportedSD);
    });
    const exc = steps.find(s => s.round.nr === 3)!;
    expect(exc.rawDiff).toBe(24.6); // Roh-Differenzial
    expect(exc.diff).toBe(23.6);    // nach Exceptional-Reduktion -1
  });

  it("applies the -1 only to rounds in the window at the event time (Nr. 3..20), not the two newer ones", () => {
    const reducedNrs = steps.filter(s => Math.abs(s.rawDiff - s.diff - 1.0) < 0.001).map(s => s.round.nr).sort((a,b)=>a-b);
    expect(reducedNrs).toEqual([3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20]);
    const unreducedNrs = steps.filter(s => Math.abs(s.rawDiff - s.diff) < 0.001).map(s => s.round.nr).sort((a,b)=>a-b);
    expect(unreducedNrs).toEqual([1,2]);
  });

  it("uses golf.de's HCPI-before as anchor for every round", () => {
    steps.forEach((step, i) => {
      expect(step.preRoundHcp).toBe(hjImport2026[i].handicapIndexBefore);
    });
  });

  it("ends at the official golf.de HCPI of 28.9", () => {
    expect(steps[steps.length - 1].hcpAfter).toBe(28.9);
  });
});