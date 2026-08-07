import { describe, expect, it } from "vitest";
import {
  buildAllocations,
  buildGameHandicaps,
  normalizeHoles,
  playedHoleCount,
  scoreBingoBangoBongo,
  scoreMatchplay,
  scoreNassau,
  scoreSkins,
  scoreWolf,
  stablefordFromHoles,
  strokeAllocation,
  strokesForHole,
  suggestHoles,
  suggestPars,
  totalPar,
  type HoleInfo,
  type HoleScores,
} from "./gameMath";

const HOLES_18 = suggestHoles(18, 72);
const HOLES_9 = suggestHoles(9, 36);

function scoresFrom(rows: Record<string, number | null>[]): HoleScores[] {
  return rows;
}

/** Alle Löcher mit demselben Bruttoscore je Spieler füllen. */
function flatScores(holeCount: number, values: Record<string, number>): HoleScores[] {
  return Array.from({ length: holeCount }, () => ({ ...values }));
}

describe("suggestPars", () => {
  it("trifft das Gesamt-Par für 18 Löcher", () => {
    for (const target of [68, 70, 71, 72, 73, 74]) {
      expect(totalPar(suggestHoles(18, target))).toBe(target);
    }
  });

  it("trifft das Gesamt-Par für 9 Löcher", () => {
    for (const target of [33, 35, 36, 37]) {
      expect(totalPar(suggestHoles(9, target))).toBe(target);
    }
  });

  it("bleibt in realistischen Par-Grenzen", () => {
    for (const par of suggestPars(18, 72)) {
      expect(par).toBeGreaterThanOrEqual(3);
      expect(par).toBeLessThanOrEqual(5);
    }
  });

  it("fällt bei fehlendem Gesamt-Par auf Par 72 zurück", () => {
    expect(totalPar(suggestHoles(18, undefined))).toBe(72);
    expect(totalPar(suggestHoles(9, undefined))).toBe(36);
  });
});

describe("suggestHoles", () => {
  it("vergibt jeden Stroke Index genau einmal", () => {
    const sis = suggestHoles(18, 72).map(hole => hole.si).sort((a, b) => a - b);
    expect(sis).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
  });

  it("legt die ungeraden Indizes auf die ersten neun Löcher", () => {
    const front = suggestHoles(18, 72).slice(0, 9).map(hole => hole.si);
    expect(front.every(si => si % 2 === 1)).toBe(true);
  });
});

describe("normalizeHoles", () => {
  it("füllt fehlende Löcher aus dem Vorschlag auf", () => {
    const holes = normalizeHoles([{ nr: 1, par: 5, si: 3 }], 18, 72);
    expect(holes).toHaveLength(18);
    expect(holes[0]).toEqual({ nr: 1, par: 5, si: 3 });
  });

  it("repariert doppelte Stroke Indizes zu einer Permutation", () => {
    const broken = Array.from({ length: 9 }, () => ({ par: 4, si: 1 }));
    const holes = normalizeHoles(broken, 9, 36);
    const sis = holes.map(hole => hole.si).sort((a, b) => a - b);
    expect(sis).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("verwirft Indizes außerhalb des gültigen Bereichs", () => {
    const holes = normalizeHoles(
      Array.from({ length: 9 }, (_, i) => ({ par: 4, si: i === 0 ? 99 : i + 1 })),
      9,
      36,
    );
    const sis = holes.map(hole => hole.si).sort((a, b) => a - b);
    expect(sis).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("klemmt unsinnige Par-Werte auf einen realistischen Bereich", () => {
    const holes = normalizeHoles([{ par: 12, si: 1 }], 9, 36);
    expect(holes[0].par).toBeLessThanOrEqual(6);
  });

  it("nimmt gültige Daten unverändert an", () => {
    expect(normalizeHoles(HOLES_9, 9, 36)).toEqual(HOLES_9);
  });
});

describe("strokesForHole", () => {
  const holeCount = 18;

  it("gibt Schläge auf den schwersten Löchern zuerst", () => {
    expect(strokesForHole(3, 1, holeCount)).toBe(1);
    expect(strokesForHole(3, 3, holeCount)).toBe(1);
    expect(strokesForHole(3, 4, holeCount)).toBe(0);
  });

  it("verteilt Handicaps über 18 auf zwei Schläge", () => {
    expect(strokesForHole(20, 1, holeCount)).toBe(2);
    expect(strokesForHole(20, 2, holeCount)).toBe(2);
    expect(strokesForHole(20, 3, holeCount)).toBe(1);
    expect(strokesForHole(20, 18, holeCount)).toBe(1);
  });

  it("zieht bei Plusvorgaben an den leichtesten Löchern ab", () => {
    expect(strokesForHole(-2, 18, holeCount)).toBe(-1);
    expect(strokesForHole(-2, 17, holeCount)).toBe(-1);
    expect(strokesForHole(-2, 16, holeCount)).toBe(0);
    expect(strokesForHole(-2, 1, holeCount)).toBe(0);
  });

  it("gibt bei Handicap 0 keine Schläge", () => {
    expect(strokesForHole(0, 1, holeCount)).toBe(0);
  });

  it("verteilt die Summe exakt auf die Löcher", () => {
    for (const handicap of [0, 1, 7, 18, 19, 36, 45]) {
      const total = strokeAllocation(handicap, HOLES_18).reduce((sum, s) => sum + s, 0);
      expect(total).toBe(handicap);
    }
  });

  it("verteilt auch auf 9 Löchern exakt", () => {
    for (const handicap of [3, 9, 14]) {
      const total = strokeAllocation(handicap, HOLES_9).reduce((sum, s) => sum + s, 0);
      expect(total).toBe(handicap);
    }
  });
});

describe("buildGameHandicaps", () => {
  it("setzt im Differenzmodus den besten Spieler auf Scratch", () => {
    expect(buildGameHandicaps([12, 20, 28], { mode: "difference", percent: 100 })).toEqual([0, 8, 16]);
  });

  it("berücksichtigt den Prozentsatz", () => {
    expect(buildGameHandicaps([10, 30], { mode: "difference", percent: 90 })).toEqual([0, 18]);
  });

  it("gibt im Vollmodus jedem sein Course Handicap", () => {
    expect(buildGameHandicaps([12, 20], { mode: "full", percent: 100 })).toEqual([12, 20]);
  });

  it("nullt im Bruttomodus alle Vorgaben", () => {
    expect(buildGameHandicaps([12, 20], { mode: "gross", percent: 100 })).toEqual([0, 0]);
  });

  it("kommt mit Plusspielern klar", () => {
    expect(buildGameHandicaps([-2, 10], { mode: "difference", percent: 100 })).toEqual([0, 12]);
  });
});

describe("scoreMatchplay", () => {
  const allocations = buildAllocations(
    [{ id: "a", courseHandicap: 10 }, { id: "b", courseHandicap: 10 }],
    HOLES_18,
    { mode: "difference", percent: 100 },
  );

  it("meldet A/S vor dem ersten Loch", () => {
    const result = scoreMatchplay("a", "b", [], allocations, HOLES_18);
    expect(result.status).toBe(0);
    expect(result.statusLabel).toEqual({ de: "A/S", en: "A/S" });
    expect(result.complete).toBe(false);
    expect(result.resultLabel).toBeNull();
  });

  it("zählt gewonnene Löcher als 1 auf", () => {
    const scores = scoresFrom([{ a: 4, b: 5 }]);
    const result = scoreMatchplay("a", "b", scores, allocations, HOLES_18);
    expect(result.status).toBe(1);
    expect(result.statusLabel).toEqual({ de: "1 auf", en: "1 up" });
    expect(result.holes[0].winner).toBe("a");
  });

  it("wertet geteilte Löcher als halved", () => {
    const result = scoreMatchplay("a", "b", scoresFrom([{ a: 4, b: 4 }]), allocations, HOLES_18);
    expect(result.status).toBe(0);
    expect(result.holes[0].winner).toBe("halved");
  });

  it("ignoriert Löcher, auf denen ein Spieler fehlt", () => {
    const result = scoreMatchplay("a", "b", scoresFrom([{ a: 4, b: null }]), allocations, HOLES_18);
    expect(result.playedHoles).toBe(0);
    expect(result.holes[0].winner).toBeNull();
  });

  it("beendet das Match mit 3 & 2", () => {
    // A gewinnt Loch 1-3, danach 13 geteilte Löcher -> nach Loch 16 steht 3 auf bei 2 Rest.
    const scores: HoleScores[] = [];
    for (let i = 0; i < 3; i += 1) scores.push({ a: 4, b: 5 });
    for (let i = 3; i < 16; i += 1) scores.push({ a: 4, b: 4 });
    const result = scoreMatchplay("a", "b", scores, allocations, HOLES_18);
    expect(result.decided).toBe(true);
    expect(result.decidedAtHole).toBe(15);
    expect(result.winner).toBe("a");
    expect(result.resultLabel).toEqual({ de: "3 & 2", en: "3 & 2" });
  });

  it("wertet ein auf dem 18. Loch entschiedenes Match als 1 auf", () => {
    const scores: HoleScores[] = [];
    for (let i = 0; i < 17; i += 1) scores.push({ a: 4, b: 4 });
    scores.push({ a: 4, b: 5 });
    const result = scoreMatchplay("a", "b", scores, allocations, HOLES_18);
    expect(result.complete).toBe(true);
    expect(result.resultLabel).toEqual({ de: "1 auf", en: "1 up" });
  });

  it("meldet ein komplett geteiltes Match als A/S", () => {
    const result = scoreMatchplay("a", "b", flatScores(18, { a: 4, b: 4 }), allocations, HOLES_18);
    expect(result.complete).toBe(true);
    expect(result.winner).toBeNull();
    expect(result.resultLabel).toEqual({ de: "Geteilt (A/S)", en: "Halved (A/S)" });
  });

  it("lässt Bagger-Löcher das Ergebnis nicht mehr verändern", () => {
    const scores: HoleScores[] = [];
    for (let i = 0; i < 10; i += 1) scores.push({ a: 4, b: 5 }); // A 10 auf nach Loch 10
    for (let i = 10; i < 18; i += 1) scores.push({ a: 6, b: 4 }); // B gewinnt alle Restlöcher
    const result = scoreMatchplay("a", "b", scores, allocations, HOLES_18);
    expect(result.decidedAtHole).toBe(9);
    expect(result.status).toBe(10);
    expect(result.resultLabel).toEqual({ de: "10 & 8", en: "10 & 8" });
    expect(result.holes[10].afterDecision).toBe(true);
  });

  it("verrechnet Vorgabenschläge netto", () => {
    const netAllocations = buildAllocations(
      [{ id: "a", courseHandicap: 5 }, { id: "b", courseHandicap: 23 }],
      HOLES_18,
      { mode: "difference", percent: 100 },
    );
    // B bekommt 18 Schläge -> auf jedem Loch einen. Brutto 5 gegen 5 heißt netto 5 zu 4.
    const result = scoreMatchplay("a", "b", scoresFrom([{ a: 5, b: 5 }]), netAllocations, HOLES_18);
    expect(result.holes[0].netA).toBe(5);
    expect(result.holes[0].netB).toBe(4);
    expect(result.status).toBe(-1);
  });

  it("liefert brutto ein anderes Ergebnis als netto", () => {
    const grossAllocations = buildAllocations(
      [{ id: "a", courseHandicap: 5 }, { id: "b", courseHandicap: 23 }],
      HOLES_18,
      { mode: "gross", percent: 100 },
    );
    const result = scoreMatchplay("a", "b", scoresFrom([{ a: 5, b: 5 }]), grossAllocations, HOLES_18);
    expect(result.status).toBe(0);
    expect(result.holes[0].winner).toBe("halved");
  });
});

describe("scoreSkins", () => {
  const ids = ["a", "b", "c"];
  const allocations = buildAllocations(
    ids.map(id => ({ id, courseHandicap: 10 })),
    HOLES_18,
    { mode: "difference", percent: 100 },
  );

  it("vergibt einen Skin an den alleinigen Sieger", () => {
    const result = scoreSkins(ids, scoresFrom([{ a: 3, b: 4, c: 5 }]), allocations, HOLES_18);
    expect(result.holes[0].winnerId).toBe("a");
    expect(result.totals.a).toBe(1);
    expect(result.totals.b).toBe(0);
  });

  it("überträgt den Topf bei Gleichstand", () => {
    const scores = scoresFrom([
      { a: 4, b: 4, c: 5 }, // geteilt -> Carry
      { a: 3, b: 5, c: 5 }, // A gewinnt 2 Skins
    ]);
    const result = scoreSkins(ids, scores, allocations, HOLES_18);
    expect(result.holes[0].carried).toBe(true);
    expect(result.holes[1].pot).toBe(2);
    expect(result.totals.a).toBe(2);
  });

  it("stapelt mehrere Überträge", () => {
    const scores = scoresFrom([
      { a: 4, b: 4, c: 4 },
      { a: 4, b: 4, c: 4 },
      { a: 4, b: 4, c: 4 },
      { a: 3, b: 4, c: 4 },
    ]);
    const result = scoreSkins(ids, scores, allocations, HOLES_18);
    expect(result.holes[3].pot).toBe(4);
    expect(result.totals.a).toBe(4);
  });

  it("lässt einen offenen Übertrag am Rundenende stehen", () => {
    const result = scoreSkins(ids, flatScores(18, { a: 4, b: 4, c: 4 }), allocations, HOLES_18);
    expect(result.openCarry).toBe(18);
    expect(Object.values(result.totals).every(value => value === 0)).toBe(true);
  });

  it("wertet ein Loch erst, wenn alle Spieler erfasst sind", () => {
    const result = scoreSkins(ids, scoresFrom([{ a: 3, b: 4, c: null }]), allocations, HOLES_18);
    expect(result.holes[0].winnerId).toBeNull();
    expect(result.holes[0].carried).toBe(false);
    expect(result.totals.a).toBe(0);
  });

  it("entscheidet netto, nicht brutto", () => {
    const netAllocations = buildAllocations(
      [{ id: "a", courseHandicap: 0 }, { id: "b", courseHandicap: 18 }],
      HOLES_18,
      { mode: "difference", percent: 100 },
    );
    // B bekommt überall einen Schlag: brutto 4 zu 4, netto 4 zu 3.
    const result = scoreSkins(["a", "b"], scoresFrom([{ a: 4, b: 4 }]), netAllocations, HOLES_18);
    expect(result.holes[0].winnerId).toBe("b");
  });
});

describe("scoreMatchplay mit Lochbereich", () => {
  const allocations = buildAllocations(
    [{ id: "a", courseHandicap: 10 }, { id: "b", courseHandicap: 10 }],
    HOLES_18,
    { mode: "difference", percent: 100 },
  );

  it("wertet nur die Löcher des Bereichs", () => {
    const scores: HoleScores[] = [];
    for (let i = 0; i < 9; i += 1) scores.push({ a: 4, b: 5 });   // A gewinnt die Front 9
    for (let i = 9; i < 18; i += 1) scores.push({ a: 5, b: 4 });  // B gewinnt die Back 9
    const front = scoreMatchplay("a", "b", scores, allocations, HOLES_18, { from: 0, to: 9 });
    const back = scoreMatchplay("a", "b", scores, allocations, HOLES_18, { from: 9, to: 18 });
    expect(front.winner).toBe("a");
    expect(back.winner).toBe("b");
  });

  it("nutzt die Vorgabenschläge des echten Lochs, nicht des Bereichsanfangs", () => {
    const netAllocations = buildAllocations(
      [{ id: "a", courseHandicap: 0 }, { id: "b", courseHandicap: 1 }],
      HOLES_18,
      { mode: "difference", percent: 100 },
    );
    // B bekommt genau einen Schlag – auf dem Loch mit Stroke Index 1 (Loch 4).
    const strokeHole = HOLES_18.findIndex(hole => hole.si === 1);
    expect(strokeHole).toBeGreaterThanOrEqual(0);
    const scores: HoleScores[] = HOLES_18.map(() => ({ a: 4, b: 4 }));
    const back = scoreMatchplay("a", "b", scores, netAllocations, HOLES_18, { from: 9, to: 18 });
    // Loch 4 liegt in der Front 9, in der Back 9 gibt es damit keinen Schlag.
    expect(strokeHole).toBeLessThan(9);
    expect(back.status).toBe(0);
  });

  it("kürzt einen Bereich über das Rundenende hinaus", () => {
    const scores: HoleScores[] = HOLES_9.map(() => ({ a: 4, b: 5 }));
    const result = scoreMatchplay("a", "b", scores, allocations, HOLES_9, { from: 0, to: 99 });
    expect(result.holes).toHaveLength(9);
  });
});

describe("scoreNassau", () => {
  const allocations = buildAllocations(
    [{ id: "a", courseHandicap: 10 }, { id: "b", courseHandicap: 10 }],
    HOLES_18,
    { mode: "difference", percent: 100 },
  );

  it("legt Front 9, Back 9 und Gesamt an", () => {
    const result = scoreNassau("a", "b", [], allocations, HOLES_18);
    expect(result.bets.map(bet => bet.label.de)).toEqual(["Front 9", "Back 9", "Gesamt"]);
    expect(result.bets.map(bet => bet.label.en)).toEqual(["Front 9", "Back 9", "Total"]);
  });

  it("führt bei 9 Löchern nur eine Wette", () => {
    const result = scoreNassau("a", "b", [], allocations, HOLES_9);
    expect(result.bets).toHaveLength(1);
    expect(result.bets[0].label).toEqual({ de: "Gesamt", en: "Total" });
  });

  it("zählt gewonnene Wetten je Seite", () => {
    const scores: HoleScores[] = [];
    for (let i = 0; i < 9; i += 1) scores.push({ a: 4, b: 5 });   // Front an A
    for (let i = 9; i < 18; i += 1) scores.push({ a: 5, b: 4 });  // Back an B
    const result = scoreNassau("a", "b", scores, allocations, HOLES_18);
    // Front an A, Back an B, Gesamt geteilt.
    expect(result.totals).toEqual({ a: 1, b: 1 });
    expect(result.bets[2].result.resultLabel).toEqual({ de: "Geteilt (A/S)", en: "Halved (A/S)" });
  });

  it("eröffnet einen Press über die Restlöcher des Segments", () => {
    const scores: HoleScores[] = [];
    for (let i = 0; i < 3; i += 1) scores.push({ a: 5, b: 4 });   // B liegt 3 vorn
    for (let i = 3; i < 9; i += 1) scores.push({ a: 4, b: 5 });   // A gewinnt den Rest
    const result = scoreNassau("a", "b", scores, allocations, HOLES_18, [{ from: 3, segment: "front" }]);
    const press = result.bets.find(bet => bet.press);
    expect(press?.label).toEqual({ de: "Front 9 Press ab Loch 4", en: "Front 9 press from hole 4" });
    expect(press?.from).toBe(3);
    expect(press?.to).toBe(9);
    expect(press?.result.winner).toBe("a");
    expect(result.bets[0].result.winner).toBe("a"); // 6:3 auf der Front insgesamt
  });

  it("ignoriert einen Press hinter dem Segmentende", () => {
    const result = scoreNassau("a", "b", [], allocations, HOLES_18, [{ from: 12, segment: "front" }]);
    expect(result.bets.some(bet => bet.press)).toBe(false);
  });
});

describe("scoreWolf", () => {
  const ids = ["a", "b", "c", "d"];
  const allocations = buildAllocations(
    ids.map(id => ({ id, courseHandicap: 10 })),
    HOLES_18,
    { mode: "difference", percent: 100 },
  );

  it("rotiert den Wolf über die Abschlagreihenfolge", () => {
    const result = scoreWolf(ids, [], allocations, HOLES_18);
    expect(result.holes.slice(0, 5).map(hole => hole.wolfId)).toEqual(["a", "b", "c", "d", "a"]);
  });

  it("bestimmt auf den Restlöchern den Punktletzten als Wolf", () => {
    // a gewinnt Loch 1 als Lone Wolf, alle anderen Löcher werden geteilt.
    const scores: HoleScores[] = HOLES_18.map((_, index) => (index === 0 ? { a: 3, b: 4, c: 4, d: 4 } : { a: 4, b: 4, c: 4, d: 4 }));
    const result = scoreWolf(ids, scores, allocations, HOLES_18, [{ partnerId: null }]);
    expect(result.rotationHoles).toBe(16);
    // a hat 3 Punkte, b/c/d je 0 -> b ist als erster Punktletzter dran.
    expect(result.holes[16].wolfId).toBe("b");
  });

  it("gibt Wolf und Partner je einen Punkt", () => {
    const scores: HoleScores[] = [{ a: 4, b: 6, c: 5, d: 5 }];
    const result = scoreWolf(ids, scores, allocations, HOLES_18, [{ partnerId: "b" }]);
    expect(result.holes[0].outcome).toBe("wolf");
    expect(result.totals).toMatchObject({ a: 1, b: 1, c: 0, d: 0 });
  });

  it("gibt bei verlorenem Team-Loch jedem Gegner einen Punkt", () => {
    const scores: HoleScores[] = [{ a: 5, b: 5, c: 4, d: 6 }];
    const result = scoreWolf(ids, scores, allocations, HOLES_18, [{ partnerId: "b" }]);
    expect(result.holes[0].outcome).toBe("opponents");
    expect(result.totals).toMatchObject({ a: 0, b: 0, c: 1, d: 1 });
  });

  it("gibt dem siegreichen Lone Wolf drei Punkte", () => {
    const scores: HoleScores[] = [{ a: 3, b: 4, c: 4, d: 4 }];
    const result = scoreWolf(ids, scores, allocations, HOLES_18, [{ partnerId: null }]);
    expect(result.totals).toMatchObject({ a: 3, b: 0, c: 0, d: 0 });
  });

  it("gibt beim verlorenen Lone Wolf jedem anderen einen Punkt", () => {
    const scores: HoleScores[] = [{ a: 5, b: 4, c: 6, d: 6 }];
    const result = scoreWolf(ids, scores, allocations, HOLES_18, [{ partnerId: null }]);
    expect(result.totals).toMatchObject({ a: 0, b: 1, c: 1, d: 1 });
  });

  it("verdoppelt Chance und Risiko beim Blind Wolf", () => {
    const win = scoreWolf(ids, [{ a: 3, b: 4, c: 4, d: 4 }], allocations, HOLES_18, [{ partnerId: null, blind: true }]);
    expect(win.totals.a).toBe(4);
    const loss = scoreWolf(ids, [{ a: 5, b: 4, c: 6, d: 6 }], allocations, HOLES_18, [{ partnerId: null, blind: true }]);
    expect(loss.totals).toMatchObject({ a: 0, b: 2, c: 2, d: 2 });
  });

  it("vergibt auf geteilten Löchern keine Punkte", () => {
    const result = scoreWolf(ids, [{ a: 4, b: 5, c: 4, d: 5 }], allocations, HOLES_18, [{ partnerId: "b" }]);
    expect(result.holes[0].outcome).toBe("halved");
    expect(Object.values(result.totals).every(value => value === 0)).toBe(true);
  });

  it("wertet ein Loch erst, wenn alle Beteiligten erfasst sind", () => {
    const result = scoreWolf(ids, [{ a: 3, b: 4, c: 4 }], allocations, HOLES_18, [{ partnerId: null }]);
    expect(result.holes[0].outcome).toBeNull();
    expect(result.totals.a).toBe(0);
  });

  it("ignoriert den Wolf als eigenen Partner", () => {
    const result = scoreWolf(ids, [{ a: 3, b: 4, c: 4, d: 4 }], allocations, HOLES_18, [{ partnerId: "a" }]);
    expect(result.holes[0].lone).toBe(true);
    expect(result.totals.a).toBe(3);
  });

  it("entscheidet netto über den besseren Ball des Teams", () => {
    const netAllocations = buildAllocations(
      [{ id: "a", courseHandicap: 0 }, { id: "b", courseHandicap: 0 }, { id: "c", courseHandicap: 0 }, { id: "d", courseHandicap: 18 }],
      HOLES_18,
      { mode: "difference", percent: 100 },
    );
    // d bekommt überall einen Schlag und rettet mit netto 4 das Loch für sein Team.
    const result = scoreWolf(ids, [{ a: 6, b: 6, c: 5, d: 5 }], netAllocations, HOLES_18, [{ partnerId: "d" }]);
    expect(result.holes[0].wolfBest).toBe(4);
    expect(result.holes[0].opponentBest).toBe(5);
    expect(result.holes[0].outcome).toBe("wolf");
  });

  it("funktioniert auch mit drei und fünf Spielern", () => {
    const three = ["a", "b", "c"];
    const threeAlloc = buildAllocations(three.map(id => ({ id, courseHandicap: 10 })), HOLES_18, { mode: "difference", percent: 100 });
    const threeResult = scoreWolf(three, [{ a: 3, b: 4, c: 4 }], threeAlloc, HOLES_18, [{ partnerId: null }]);
    expect(threeResult.rotationHoles).toBe(18);
    expect(threeResult.totals.a).toBe(3);

    const five = ["a", "b", "c", "d", "e"];
    const fiveAlloc = buildAllocations(five.map(id => ({ id, courseHandicap: 10 })), HOLES_18, { mode: "difference", percent: 100 });
    const fiveResult = scoreWolf(five, [], fiveAlloc, HOLES_18);
    expect(fiveResult.rotationHoles).toBe(15);
    expect(fiveResult.holes.slice(0, 5).map(hole => hole.wolfId)).toEqual(five);
  });

  it("bleibt bei unter drei Spielern wirkungslos", () => {
    const two = ["a", "b"];
    const twoAlloc = buildAllocations(two.map(id => ({ id, courseHandicap: 10 })), HOLES_18, { mode: "difference", percent: 100 });
    const result = scoreWolf(two, [{ a: 3, b: 5 }], twoAlloc, HOLES_18, [{ partnerId: null }]);
    expect(result.holes[0].wolfId).toBeNull();
    expect(result.totals).toEqual({ a: 0, b: 0 });
  });
});

describe("scoreBingoBangoBongo", () => {
  const ids = ["a", "b", "c"];

  it("gibt je Kategorie einen Punkt", () => {
    const result = scoreBingoBangoBongo(ids, [{ bingo: "a", bango: "b", bongo: "a" }], 18);
    expect(result.totals).toMatchObject({ a: 2, b: 1, c: 0 });
  });

  it("schlüsselt die Kategorien für die Statistik auf", () => {
    const result = scoreBingoBangoBongo(ids, [
      { bingo: "a", bango: "a", bongo: "a" },
      { bingo: "a", bango: "b", bongo: "c" },
    ], 18);
    expect(result.byAward.a).toEqual({ bingo: 2, bango: 1, bongo: 1 });
    expect(result.byAward.c).toEqual({ bingo: 0, bango: 0, bongo: 1 });
  });

  it("ignoriert unbesetzte und unbekannte Spieler", () => {
    const result = scoreBingoBangoBongo(ids, [{ bingo: null, bango: "x", bongo: "b" }], 18);
    expect(result.holes[0].points).toBe(1);
    expect(result.totals).toMatchObject({ a: 0, b: 1, c: 0 });
  });

  it("kommt mit fehlenden Löchern klar", () => {
    const result = scoreBingoBangoBongo(ids, [], 18);
    expect(result.holes).toHaveLength(18);
    expect(Object.values(result.totals).every(value => value === 0)).toBe(true);
  });
});

describe("playedHoleCount", () => {
  it("zählt Löcher mit mindestens einem Eintrag", () => {
    const scores = scoresFrom([{ a: 4, b: 4 }, { a: 5, b: null }, { a: null, b: null }]);
    expect(playedHoleCount(scores, ["a", "b"], 18)).toBe(2);
  });
});

describe("stablefordFromHoles", () => {
  const holes: HoleInfo[] = HOLES_18;
  const [allocation] = buildAllocations([{ id: "a", courseHandicap: 18 }], holes, {
    mode: "full",
    percent: 100,
  });

  it("gibt 2 Punkte für ein Netto-Par", () => {
    const scores = holes.map(hole => ({ a: hole.par + 1 })); // überall ein Schlag Vorgabe
    const summary = stablefordFromHoles("a", scores, allocation, holes);
    expect(summary.netPoints).toBe(36);
    expect(summary.complete).toBe(true);
    expect(summary.grossTotal).toBe(totalPar(holes) + 18);
  });

  it("gibt keine negativen Punkte", () => {
    const scores = holes.map(hole => ({ a: hole.par + 10 }));
    const summary = stablefordFromHoles("a", scores, allocation, holes);
    expect(summary.netPoints).toBe(0);
  });

  it("zählt nur erfasste Löcher", () => {
    const scores: HoleScores[] = [{ a: holes[0].par + 1 }];
    const summary = stablefordFromHoles("a", scores, allocation, holes);
    expect(summary.holesCounted).toBe(1);
    expect(summary.complete).toBe(false);
    expect(summary.netPoints).toBe(2);
  });
});
