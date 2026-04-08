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