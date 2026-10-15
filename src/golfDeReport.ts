/**
 * Liest die Runden aus dem detaillierten golf.de Scoring Record.
 *
 * Die Funktion arbeitet auf dem fertigen Text des PDFs und ist deshalb ohne
 * PDF-Werkzeug testbar. Das Herausziehen des Textes aus dem PDF passiert im
 * Aufrufer.
 */

import { calcCourseHandicap, round1 } from "./hcpMath";

function round3(value: number) {
  return Math.round(value * 1000) / 1000;
}

export function normalizeText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function normalizeWhitespace(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function parseGermanNumber(value: unknown): number | null {
  const raw = normalizeWhitespace(String(value ?? ""));
  if (!raw) return null;

  const tokenMatch = raw.match(/-?\d[\d.,]*/);
  if (!tokenMatch) return null;

  let token = tokenMatch[0].replace(/[.,]+$/, "");
  if (!token) return null;

  const lastComma = token.lastIndexOf(",");
  const lastDot = token.lastIndexOf(".");
  let normalized = token;

  if (lastComma >= 0 && lastDot >= 0) {
    const decimalSeparator = lastComma > lastDot ? "," : ".";
    const thousandsSeparator = decimalSeparator === "," ? "." : ",";
    normalized = token.replace(new RegExp(`\\${thousandsSeparator}`, "g"), "").replace(decimalSeparator, ".");
  } else if (lastComma >= 0) {
    normalized = token.replace(",", ".");
  } else if (lastDot >= 0) {
    const fractionalDigits = token.length - lastDot - 1;
    normalized = fractionalDigits > 0 && fractionalDigits <= 2
      ? token
      : token.replace(/\./g, "");
  }

  const parsed = parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseGolfDeDate(value: unknown): string {
  const match = String(value ?? "").match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) return "";
  return `${match[3]}-${match[2]}-${match[1]}`;
}

export function mapGolfDeTee(value: unknown): string {
  const normalized = normalizeText(value);
  if (!normalized) return "Gelb";
  if (normalized.startsWith("gelb")) return "Gelb";
  if (normalized.startsWith("weiss") || normalized.startsWith("weis")) return "Weiß";
  if (normalized.startsWith("blau")) return "Blau";
  if (normalized.startsWith("rot")) return "Rot";
  return value ? `${String(value).charAt(0).toUpperCase()}${String(value).slice(1)}` : "Gelb";
}

export function parseGolfDeDetailedReport(text: string) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map(line=>normalizeWhitespace(line))
    .filter(line=>line && !/^seite\s+\d+/i.test(line) && !/^scoring record/i.test(line) && !/^hcpi\s+/i.test(line));
  const summaryPattern = /^(\d+)\s+(\d{2}\.\d{2}\.\d{4})\s+\d+\s+(.+?)(?:\s*)(9|18)\s+([A-Z])\s+(\d+)\s+(-?\d+(?:[.,]\d+)?)$/i;
  const parsedRounds = [];
  const detailLabels = ["Club", "Platz", "Course", "Country", "Rd.", "Runde", "PCC", "Tees", "Tee", "Abschlag", "Par", "CR", "Course Rating", "Slope", "Slope Rating", "HCPI", "HI", "CH", "PHCP", "Playing HCP", "ExSc", "ExSc.", "Exact Score", "Score"];

  const buildDetailMap = (detailLines) => {
    const block = detailLines.join(" ");
    const escapedLabels = detailLabels.map(label=>label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const regex = new RegExp(`(${escapedLabels.join("|")}):`, "gi");
    const map = new Map();
    const matches = [];
    let currentMatch;

    while ((currentMatch = regex.exec(block)) !== null) {
      matches.push(currentMatch);
    }

    for (let index = 0; index < matches.length; index += 1) {
      const current = matches[index];
      const next = matches[index + 1];
      const key = current[1].toLowerCase();
      const valueStart = current.index + current[0].length;
      const valueEnd = next ? next.index : block.length;
      const value = normalizeWhitespace(block.slice(valueStart, valueEnd));
      // Die eigenen Angaben der Runde stehen vorn. Was spaeter noch einmal
      // so heisst, gehoert nicht zu ihr und darf sie nicht ueberschreiben.
      if (!map.has(key)) map.set(key, value);
    }

    return map;
  };

  const readDetailValue = (detailMap, labels) => {
    const variants = Array.isArray(labels) ? labels : [labels];
    for (const variant of variants) {
      const value = detailMap.get(String(variant).toLowerCase());
      if (value) return value;
    }
    return "";
  };

  const parseSummaryLine = (line) => {
    const match = line.match(summaryPattern);
    if (match) return match;

    const compact = line.split(/\s+/);
    if (compact.length < 8) return null;
    const diffToken = compact[compact.length - 1];
    const gbeToken = compact[compact.length - 2];
    const artToken = compact[compact.length - 3];
    const holesToken = compact[compact.length - 4];
    const clubNumberToken = compact[compact.length - 5];
    const dateToken = compact[1];
    const roundNumberToken = compact[0];
    if (!/^[0-9]+$/.test(roundNumberToken || "") || !/^\d{2}\.\d{2}\.\d{4}$/.test(dateToken || "")) return null;
    if (!/^[0-9]+$/.test(clubNumberToken || "") || !/^(9|18)$/.test(holesToken || "") || !/^[A-Z]$/i.test(artToken || "") || !/^\d+$/.test(gbeToken || "") || !/^-?\d+(?:[.,]\d+)?$/.test(diffToken || "")) return null;
    return [line, roundNumberToken, dateToken, compact.slice(2, -5).join(" "), holesToken, artToken, gbeToken, diffToken];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const match = parseSummaryLine(lines[index]);
    if (!match) continue;

    // Unter der letzten Runde druckt golf.de die Legende ("HCPI: Handicap-Index",
    // "GBE: ... (auf 18 Loecher)" ...). Sie gehoert nicht mehr zur Runde - sonst
    // liest der Parser dort "18" als HCPI davor, und bei einer 9-Loch-Runde
    // stimmt dann das Differenzial nicht mehr.
    const detailLines = [];
    let nextIndex = index + 1;
    while (nextIndex < lines.length && !parseSummaryLine(lines[nextIndex]) && !/^legende\b/i.test(lines[nextIndex])) {
      detailLines.push(lines[nextIndex]);
      nextIndex += 1;
    }

    index = nextIndex - 1;
  const detailMap = buildDetailMap(detailLines);

    const sourceRoundId = parseInt(match[1], 10);
    const date = parseGolfDeDate(match[2]);
    const summaryCourseName = normalizeWhitespace(match[3]);
    const holes = parseInt(match[4], 10);
    const art = match[5];
    const gbe = parseInt(match[6], 10);
    const reportedDiff = parseGermanNumber(match[7]);
  const club = readDetailValue(detailMap, ["Club", "Platz", "Course"]) || summaryCourseName;
  const tee = mapGolfDeTee(readDetailValue(detailMap, ["Tees", "Tee", "Abschlag"]));
  const par = parseInt(readDetailValue(detailMap, "Par"), 10);
  const courseRating = parseGermanNumber(readDetailValue(detailMap, ["CR", "Course Rating"]));
  const slopeRating = parseInt(readDetailValue(detailMap, ["Slope", "Slope Rating"]), 10);
  const handicapIndexBefore = parseGermanNumber(readDetailValue(detailMap, ["HCPI", "HI"]));
  const playingHcp = parseGermanNumber(readDetailValue(detailMap, ["CH", "PHCP", "Playing HCP"]));
  const exactScore = parseInt(readDetailValue(detailMap, ["ExSc", "ExSc.", "Exact Score", "Score"]), 10);
  const pcc = parseInt(readDetailValue(detailMap, "PCC"), 10) || 0;
  const importedGbe = Number.isFinite(exactScore) && exactScore > 0 ? exactScore : gbe;
    const baseCourseHandicap = holes === 9 && handicapIndexBefore !== null && courseRating !== null && Number.isFinite(slopeRating) && Number.isFinite(par)
      ? calcCourseHandicap(handicapIndexBefore, courseRating, slopeRating, par)
      : null;
    const nineHolePhcpFactor = holes === 9 && Number.isFinite(playingHcp) && Number.isFinite(baseCourseHandicap) && baseCourseHandicap
      ? round3(playingHcp / baseCourseHandicap)
      : null;

    if (!date || !club || !Number.isFinite(par) || !Number.isFinite(slopeRating) || courseRating === null) continue;

    parsedRounds.push({
      source: "golf.de-pdf",
      sourceRoundId,
      date,
      courseName: club,
      course: {
        name: club,
        tee,
        par,
        courseRating,
        slopeRating,
        nineHolePhcpFactor,
      },
      mode: art === "S" ? "Stableford" : "Stroke Play",
      format: "Einzel",
      holes,
      submitted: true,
      markerSigned: true,
      nineHoleAllowed: holes === 9,
      playingHcp: Number.isFinite(playingHcp) ? round1(playingHcp) : "",
      courseRating,
      slopeRating,
      par,
      gbe: Number.isFinite(importedGbe) ? importedGbe : "",
      adjustedGross: Number.isFinite(importedGbe) ? importedGbe : "",
      reportedDiff,
      handicapIndexBefore,
      pcc,
      tee,
    });
  }

  const detailedRounds = parsedRounds.filter(round=>Number.isFinite(round.courseRating) && Number.isFinite(round.slopeRating) && Number.isFinite(round.par));
  if (!detailedRounds.length) {
    throw new Error("Kein detaillierter golf.de-Report erkannt. Bitte immer den detaillierten Report als PDF drucken.");
  }
  return detailedRounds;
}
