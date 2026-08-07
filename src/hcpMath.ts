export type HandicapRoundLike = {
  source?: string;
  reportedDiff?: number | string;
  courseRating?: number | string;
  slopeRating?: number | string;
  gbe?: number | string;
  adjustedGross?: number | string;
  holes?: number | string;
};

export function round1(value: number) {
  return Math.round(value * 10) / 10;
}

export function getGrossScore(round: HandicapRoundLike) {
  const gbe = parseFloat(String(round.gbe ?? ""));
  if (Number.isFinite(gbe)) return gbe;
  const adjustedGross = parseFloat(String(round.adjustedGross ?? ""));
  return Number.isFinite(adjustedGross) ? adjustedGross : null;
}

export function calcExpectedNineHoleDiff(handicapIndex: number | string) {
  const base = Math.min(54, Math.max(0, parseFloat(String(handicapIndex)) || 54));
  return round1(((base * 1.04) + 2.4) / 2);
}

export function calcCourseHandicap(
  handicapIndex: number | string,
  courseRating: number | string,
  slopeRating: number | string,
  par: number | string,
) {
  const hi = parseFloat(String(handicapIndex));
  const cr = parseFloat(String(courseRating));
  const sr = parseFloat(String(slopeRating));
  const scorePar = parseInt(String(par), 10);
  if (!Number.isFinite(hi) || !Number.isFinite(cr) || !Number.isFinite(sr) || !Number.isFinite(scorePar)) return null;
  return (hi * sr) / 113 + (cr - scorePar);
}

export function calcRawScoreDiff(round: HandicapRoundLike, handicapIndexForNineHole?: number | string) {
  const cr = parseFloat(String(round.courseRating));
  const sr = parseFloat(String(round.slopeRating));
  const gross = getGrossScore(round);
  if (!cr || !sr || gross === null) return null;
  if (parseInt(String(round.holes), 10) === 9) {
    const playedNineDiff = ((gross - cr) * 113) / sr;
    return round1(playedNineDiff + calcExpectedNineHoleDiff(handicapIndexForNineHole ?? 54));
  }
  return round1(((gross - cr) * 113) / sr);
}

export function calcScoreDiff(round: HandicapRoundLike, handicapIndexForNineHole?: number | string) {
  const reportedDiff = parseFloat(String(round.reportedDiff ?? ""));
  if (round?.source === "golf.de-pdf" && Number.isFinite(reportedDiff)) {
    return round1(reportedDiff);
  }
  return calcRawScoreDiff(round, handicapIndexForNineHole);
}

export type HandicapRule = { maxRounds: number; take: number; adj: number };

// WHS Handicap-Index-Tabelle: Anzahl der wertbaren Ergebnisse -> Anzahl der besten
// Differenziale und die Anpassung, die EINMAL auf den Mittelwert addiert wird
// (nicht auf die einzelnen Differenziale).
export const HCP_RULES: HandicapRule[] = [
  {maxRounds:3,take:1,adj:-2},
  {maxRounds:4,take:1,adj:-1},
  {maxRounds:5,take:1,adj:0},
  {maxRounds:6,take:2,adj:-1},
  {maxRounds:8,take:2,adj:0},
  {maxRounds:11,take:3,adj:0},
  {maxRounds:14,take:4,adj:0},
  {maxRounds:16,take:5,adj:0},
  {maxRounds:18,take:6,adj:0},
  {maxRounds:19,take:7,adj:0},
  {maxRounds:20,take:8,adj:0},
];

export function getHandicapRule(roundCount: number): HandicapRule {
  return HCP_RULES.find(rule=>roundCount<=rule.maxRounds) || HCP_RULES[HCP_RULES.length-1];
}

export function calcHcp(diffs: number[]): number | null {
  if (!diffs.length) return null;
  const n = Math.min(diffs.length, 20);
  const {take,adj} = getHandicapRule(n);
  const best = [...diffs].sort((a,b)=>a-b).slice(0,take);
  const avg = best.reduce((s,d)=>s+d,0)/best.length;
  return Math.min(54, round1(avg + adj));
}

// Oberhalb dieses Handicap-Index gilt die DGV-Anfängerregel (siehe unten).
export const BEGINNER_RETENTION_MAX = 26.9;

// DGV-Anfängerregel ("Bremse"): Solange der Handicap-Index über
// BEGINNER_RETENTION_MAX liegt, wird ein bereits erspielter (niedrigerer) Index
// nicht wieder angehoben – er kann in diesem Bereich nur besser werden. Sobald
// 26.9 oder besser erreicht ist, entfällt die Sperre und der Index bewegt sich
// normal in beide Richtungen.
//
// baseHcp    = frisch aus den Differenzialen berechneter WHS-Grundwert
// previousHcp = zuletzt geführter (offizieller) Index vor dieser Runde
export function applyBeginnerRetention(baseHcp: number, previousHcp: number): number {
  if (previousHcp > BEGINNER_RETENTION_MAX && baseHcp > previousHcp) {
    return previousHcp;
  }
  return baseHcp;
}

// Exceptional Score (WHS Regel 5.9): Liegt das gerade gespielte Differenzial
// deutlich unter dem zum Spielzeitpunkt gültigen Index, wird eine Reduktion
// ausgelöst, die auf ALLE Differenziale im aktuellen 20er-Fenster wirkt.
//   7.0–9.9 Schläge darunter -> -1.0
//   >= 10.0 Schläge darunter  -> -2.0
export function exceptionalScoreReduction(previousHcp: number, rawDiff: number): number {
  const gap = previousHcp - rawDiff;
  if (gap >= 10) return 2.0;
  if (gap >= 7) return 1.0;
  return 0;
}

export type TimelineRound = {
  holes?: number | string;
  gbe?: number | string;
  adjustedGross?: number | string;
  courseRating?: number | string;
  slopeRating?: number | string;
  source?: string;
  handicapIndexBefore?: number | string;
};

export type TimelineStep<T> = {
  round: T;
  preRoundHcp: number; // geführter Index VOR dieser Runde
  rawDiff: number;     // Differenzial VOR Exceptional-Score-Reduktion
  diff: number;        // finales Differenzial (nach allen Reduktionen) = golf.de "SD"
  hcpAfter: number;    // geführter Index NACH dieser Runde (inkl. Bremse)
};

function clampHcp(v: number) {
  return Math.min(54, Math.max(0, v));
}

// Chronologische WHS-Engine. Erwartet bereits gefilterte, chronologisch
// sortierte Runden. Modelliert – in dieser Reihenfolge – pro Runde:
//   1. Rohdifferenzial (9-Loch nutzt den erwarteten Wert aus dem Index davor)
//   2. Exceptional-Score-Reduktion zum Ereigniszeitpunkt auf das 20er-Fenster
//   3. WHS-Grundwert aus den besten N der letzten 20 Differenziale
//   4. DGV-Anfängerregel (Bremse)
// Wichtig: Die Reduktion greift chronologisch genau dann, wenn die
// Ausnahmerunde gespielt wurde – nicht rückwirkend in den Rohdaten.
//
// Für golf.de-Importe wird als "Index davor" der von golf.de geführte
// handicapIndexBefore verwendet. Das ist der exakte historische Index und
// verhindert, dass ein selbst nachgerechneter Verlauf abdriftet und dadurch
// z. B. die 7-Schläge-Schwelle des Exceptional Scores knapp verfehlt.
export function buildIndexTimeline<T extends TimelineRound>(
  rounds: T[],
  startHcp: number | string = 54,
): TimelineStep<T>[] {
  let currentHcp = clampHcp(parseFloat(String(startHcp)) || 54);
  const window: { stepIndex: number; diff: number }[] = [];
  const steps: TimelineStep<T>[] = [];

  const importedBefore = (round: T) => {
    const v = parseFloat(String(round.handicapIndexBefore ?? ""));
    return round.source === "golf.de-pdf" && Number.isFinite(v) ? clampHcp(v) : null;
  };

  for (const round of rounds) {
    const anchored = importedBefore(round);
    const preRoundHcp = anchored ?? currentHcp;
    const rawDiff = calcRawScoreDiff(round, preRoundHcp);
    if (rawDiff === null) continue;

    const stepIndex = steps.length;
    window.push({ stepIndex, diff: rawDiff });

    const reduction = exceptionalScoreReduction(preRoundHcp, rawDiff);
    if (reduction > 0) {
      for (const entry of window.slice(-20)) entry.diff = round1(entry.diff - reduction);
    }

    const base = calcHcp(window.slice(-20).map(entry => entry.diff));
    currentHcp = base === null ? preRoundHcp : applyBeginnerRetention(base, preRoundHcp);

    steps.push({ round, preRoundHcp, rawDiff, diff: rawDiff, hcpAfter: currentHcp });
  }

  // Endgültige (ggf. reduzierte) Differenziale zurückschreiben, damit Anzeige,
  // Zähl-Logik und Projektion mit den finalen Werten (= golf.de "SD") arbeiten.
  for (const entry of window) steps[entry.stepIndex].diff = entry.diff;

  // Historischen Verlauf (hcpAfter) für Importe exakt aus golf.de's HCPI-davor
  // der jeweils nächsten Runde übernehmen; der letzte Wert bleibt berechnet.
  for (let k = 0; k < steps.length - 1; k += 1) {
    const nextBefore = importedBefore(steps[k + 1].round);
    if (nextBefore !== null) steps[k].hcpAfter = nextBefore;
  }

  return steps;
}
