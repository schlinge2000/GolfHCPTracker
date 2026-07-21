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
