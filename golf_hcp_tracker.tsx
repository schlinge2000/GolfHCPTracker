import { useState, useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import pdfWorkerSrc from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

import { calcCourseHandicap, calcExpectedNineHoleDiff, calcScoreDiff, round1, getGrossScore, calcHcp, getHandicapRule, HCP_RULES, applyBeginnerRetention, exceptionalScoreReduction, buildIndexTimeline } from "./src/hcpMath";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

type PwaUpdateEvent = CustomEvent<{
  updateSW: (reloadPage?: boolean) => Promise<void>;
}>;

const TEES = ["Gelb","Weiß","Blau","Rot"];
const MODES = ["Stableford","Stroke Play"];
const FORMATS = ["Einzel","Vierer","Vierball"];
const GITHUB_REPO_URL = "https://github.com/schlinge2000/GolfHCPTracker";
const GITHUB_ISSUES_URL = "https://github.com/schlinge2000/GolfHCPTracker/issues";
const COLORS = { hcp:"#1D9E75", stroke:"#378ADD", stableford:"#7F77DD", border:"var(--color-border-tertiary)", textSec:"var(--color-text-secondary)" };
const inp: CSSProperties = { width:"100%", boxSizing:"border-box", padding:"10px 12px", borderRadius:"var(--border-radius-md)", border:"1px solid var(--color-border-secondary)", background:"rgba(255,255,255,0.9)", color:"var(--color-text-primary)", fontSize:14, fontFamily:"var(--font-sans)", boxShadow:"inset 0 1px 0 rgba(255,255,255,0.55)" };
const sel = { ...inp };
const appShellPadding = "max(1rem, calc(env(safe-area-inset-top) + 0.5rem)) max(1rem, calc(env(safe-area-inset-right) + 1rem)) calc(env(safe-area-inset-bottom) + 3rem) max(1rem, calc(env(safe-area-inset-left) + 1rem))";
// Der Sidebar-Shell setzt den Top-Inset selbst (Rail bzw. mobile Topbar), daher hier ohne safe-area-inset-top.
const contentShellPadding = "1.25rem max(1rem, calc(env(safe-area-inset-right) + 1rem)) calc(env(safe-area-inset-bottom) + 3rem) max(1rem, calc(env(safe-area-inset-left) + 1rem))";
const cardStyle: CSSProperties = { background:"rgba(255,255,255,0.92)", border:"1px solid var(--color-border-tertiary)", borderRadius:"var(--border-radius-lg)", boxShadow:"var(--shadow-card)", backdropFilter:"blur(14px)" };
const subtleCardStyle: CSSProperties = { background:"linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(246,248,245,0.95) 100%)", border:"1px solid var(--color-border-tertiary)", borderRadius:"var(--border-radius-md)", boxShadow:"var(--shadow-soft)" };

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function normalizeCourse(course) {
  const factor = parseFloat(course?.nineHolePhcpFactor);
  return {
    ...course,
    nineHolePhcpFactor: Number.isFinite(factor) && factor > 0 ? round3(factor) : 0.5,
  };
}

function normalizeDB(data) {
  const safe = data && typeof data === "object" ? data : {};
  const courses = Array.isArray(safe.courses) ? safe.courses.map(normalizeCourse) : [];
  const rounds = Array.isArray(safe.rounds) ? safe.rounds : [];
  const simulatedRounds = Array.isArray(safe.simulatedRounds) ? safe.simulatedRounds : [];
  const nextRoundId = Number.isFinite(safe.nextRoundId)
    ? safe.nextRoundId
    : [...rounds, ...simulatedRounds].reduce((maxId, round)=>Math.max(maxId, round.id || 0), 0) + 1;
  const nextCourseId = Number.isFinite(safe.nextCourseId)
    ? safe.nextCourseId
    : courses.reduce((maxId, course)=>Math.max(maxId, course.id || 0), 0) + 1;

  return {
    courses,
    rounds,
    simulatedRounds,
    profile: safe.profile || {name:"", startHcp:54},
    nextRoundId,
    nextCourseId,
  };
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function parseGermanNumber(value) {
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

function parseGolfDeDate(value) {
  const match = String(value ?? "").match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) return "";
  return `${match[3]}-${match[2]}-${match[1]}`;
}

function mapGolfDeTee(value) {
  const normalized = normalizeText(value);
  if (!normalized) return "Gelb";
  if (normalized.startsWith("gelb")) return "Gelb";
  if (normalized.startsWith("weiss") || normalized.startsWith("weis")) return "Weiß";
  if (normalized.startsWith("blau")) return "Blau";
  if (normalized.startsWith("rot")) return "Rot";
  return value ? `${String(value).charAt(0).toUpperCase()}${String(value).slice(1)}` : "Gelb";
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value)=>sum + value, 0) / values.length;
}

function buildCourseImportKey(course) {
  return [
    normalizeText(course.name),
    normalizeText(course.tee),
    String(parseFloat(course.courseRating) || ""),
    String(parseInt(course.slopeRating) || ""),
    String(parseInt(course.par) || ""),
  ].join("|");
}

function buildRoundImportKey(round) {
  if (round.source === "golf.de-pdf" && round.sourceRoundId) {
    return `golf.de-pdf|${round.sourceRoundId}|${round.date}`;
  }
  return [
    round.date,
    normalizeText(round.courseName),
    String(parseInt(round.holes) || ""),
    String(parseFloat(round.playingHcp) || ""),
    String(parseInt(round.gbe || round.adjustedGross) || ""),
  ].join("|");
}

function isGolfDeImportedRound(round) {
  return round?.source === "golf.de-pdf";
}

async function extractGolfDePdfText(file) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;
  }
  const bytes = new Uint8Array(await readFileAsArrayBuffer(file));
  const document = await pdfjs.getDocument({ data: bytes, disableWorker: true } as any).promise;
  const pages = [];

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const lines = [];
    let currentLine = "";

    for (const item of content.items) {
      if (!("str" in item)) continue;
      const text = normalizeWhitespace(item.str);
      if (text) currentLine = currentLine ? `${currentLine} ${text}` : text;
      if (item.hasEOL && currentLine) {
        lines.push(currentLine);
        currentLine = "";
      }
    }

    if (currentLine) lines.push(currentLine);
    pages.push(lines.join("\n"));
  }

  return pages.join("\n");
}

function readFileAsArrayBuffer(file) {
  if (file && typeof file.arrayBuffer === "function") {
    return file.arrayBuffer();
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("PDF konnte nicht gelesen werden."));
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
        return;
      }
      reject(new Error("PDF konnte nicht gelesen werden."));
    };
    reader.readAsArrayBuffer(file);
  });
}

// golf.de detailed PDF parser
function parseGolfDeDetailedReport(text) {
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
      map.set(key, value);
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

    const detailLines = [];
    let nextIndex = index + 1;
    while (nextIndex < lines.length && !parseSummaryLine(lines[nextIndex])) {
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

function mergeGolfDeImport(currentDb, importedRounds) {
  const nextDb = normalizeDB(currentDb);
  const courses = [...nextDb.courses];
  const rounds = [...nextDb.rounds];
  let nextCourseId = nextDb.nextCourseId;
  let nextRoundId = nextDb.nextRoundId;
  const courseIdsByKey = new Map(courses.map(course=>[buildCourseImportKey(course), course.id]));
  const roundKeys = new Set(rounds.map(buildRoundImportKey));
  let createdCourses = 0;
  let importedRoundCount = 0;
  let skippedRounds = 0;

  for (const importedRound of importedRounds) {
    const courseKey = buildCourseImportKey(importedRound.course);
    let courseId = courseIdsByKey.get(courseKey);

    if (!courseId) {
      courseId = nextCourseId;
      nextCourseId += 1;
      courses.push(normalizeCourse({
        id: courseId,
        name: importedRound.course.name,
        tee: importedRound.course.tee,
        courseRating: importedRound.course.courseRating,
        slopeRating: importedRound.course.slopeRating,
        par: importedRound.course.par,
        notes: "Automatisch aus golf.de PDF erstellt.",
        nineHolePhcpFactor: importedRound.course.nineHolePhcpFactor ?? 0.5,
      }));
      courseIdsByKey.set(courseKey, courseId);
      createdCourses += 1;
    } else if (importedRound.course.nineHolePhcpFactor) {
      const courseIndex = courses.findIndex(course=>course.id === courseId);
      if (courseIndex >= 0) {
        const existingCourse = courses[courseIndex];
        const existingFactor = parseFloat(existingCourse.nineHolePhcpFactor);
        if (!Number.isFinite(existingFactor) || Math.abs(existingFactor - 0.5) < 0.001) {
          courses[courseIndex] = normalizeCourse({
            ...existingCourse,
            nineHolePhcpFactor: importedRound.course.nineHolePhcpFactor,
          });
        }
      }
    }

    const roundRecord = {
      ...importedRound,
      id: nextRoundId,
      createdAt: new Date().toISOString(),
      courseId,
    };
    const roundKey = buildRoundImportKey(roundRecord);
    if (roundKeys.has(roundKey)) {
      skippedRounds += 1;
      continue;
    }

    nextRoundId += 1;
    roundKeys.add(roundKey);
    rounds.push(roundRecord);
    importedRoundCount += 1;
  }

  return {
    db: normalizeDB({ ...nextDb, courses, rounds, nextCourseId, nextRoundId }),
    summary: {
      importedRounds: importedRoundCount,
      createdCourses,
      skippedRounds,
    },
  };
}

function replaceGolfDeImport(currentDb, importedRounds) {
  const nextDb = normalizeDB({
    profile: normalizeDB(currentDb).profile,
    courses: [],
    rounds: [],
    simulatedRounds: [],
    nextRoundId: 1,
    nextCourseId: 1,
  });

  return mergeGolfDeImport(nextDb, importedRounds);
}

function initDB() {
  try {
    const raw = localStorage.getItem("golf_hcp_db");
    if (raw) return normalizeDB(JSON.parse(raw));
  } catch(e) {}
  return normalizeDB(null);
}
function saveDB(db) { try { localStorage.setItem("golf_hcp_db", JSON.stringify(db)); } catch(e) {} }

function isHcpEligible(r) {
  return r.submitted && r.markerSigned && r.format==="Einzel" &&
    ["Stableford","Stroke Play"].includes(r.mode) &&
    (parseInt(r.holes)===18 || r.nineHoleAllowed);
}

function getNineHolePhcpFactor(course) {
  const factor = parseFloat(course?.nineHolePhcpFactor);
  return Number.isFinite(factor) && factor > 0 ? factor : 0.5;
}

function calcPlayingHcpFromCourse(handicapIndex, course, holesOverride) {
  const holes = parseInt(holesOverride ?? course?.holes) || 18;
  const courseHandicap = calcCourseHandicap(handicapIndex, course?.courseRating, course?.slopeRating, course?.par);
  if (courseHandicap===null) return null;
  const factor = holes===9 ? getNineHolePhcpFactor(course) : 1;
  return Math.max(0, Math.round(courseHandicap * factor));
}

function getAdjustedPlayingHcp(playingHcp) {
  return parseFloat(playingHcp) || 0;
}

function calcAdjustedGrossFromStableford({par, playingHcp, holes, stablefordPoints}) {
  const scorePar = parseInt(par) || (parseInt(holes)===9 ? 36 : 72);
  const points = parseInt(stablefordPoints);
  if (!Number.isFinite(points)) return null;
  const adjustedPlayingHcp = getAdjustedPlayingHcp(playingHcp);
  const stablefordBase = parseInt(holes)===9 ? 18 : 36;
  return Math.round(scorePar + adjustedPlayingHcp + stablefordBase - points);
}

function buildProjectedHandicap({recentDiffs, currentHcp, round}) {
  const diff = calcScoreDiff(round, currentHcp);
  if (diff===null) return null;

  // Ausnahmerunde: senkt ggf. das gesamte aktuelle Fenster (WHS 5.9).
  const reduction = exceptionalScoreReduction(currentHcp, diff);
  const nextDiffs = [...recentDiffs, diff].slice(-20).map(d=>reduction>0 ? round1(d - reduction) : d);
  const base = calcHcp(nextDiffs);
  const nextHcp = base === null ? currentHcp : applyBeginnerRetention(base, currentHcp);
  const rule = getHandicapRule(nextDiffs.length);
  const sortedEntries = nextDiffs.map((value, index)=>({value, index})).sort((a,b)=>a.value-b.value || a.index-b.index);
  const countingEntries = sortedEntries.slice(0, rule.take);
  const countingDiffs = countingEntries.map(entry=>entry.value);
  const wouldCount = countingEntries.some(entry=>entry.index===nextDiffs.length-1);

  // Kontext für die Erklärung, wie sich das Wertungsfenster verändert.
  const windowCountBefore = recentDiffs.length;
  const windowFullBefore = windowCountBefore >= 20;
  const droppedDiff = windowFullBefore ? recentDiffs[0] : null; // fällt aus dem 20er-Fenster
  const prevRule = windowCountBefore > 0 ? getHandicapRule(Math.min(windowCountBefore, 20)) : null;
  const prevCounting = prevRule ? [...recentDiffs].sort((a,b)=>a-b).slice(0, prevRule.take) : [];
  const prevWorstCounting = prevCounting.length ? prevCounting[prevCounting.length-1] : null;
  const takeGrew = prevRule ? rule.take > prevRule.take : true;
  const replacedCountingDiff = (wouldCount && !takeGrew && prevWorstCounting!==null && prevCounting.length===rule.take && diff < prevWorstCounting)
    ? prevWorstCounting : null;
  const countingAvg = countingDiffs.length ? round1(countingDiffs.reduce((s,d)=>s+d,0)/countingDiffs.length) : null;
  const retentionHeld = base!==null && Math.abs(base - nextHcp) > 0.001;

  return {
    diff,
    nextHcp,
    nextDiffs,
    rule,
    countingDiffs,
    wouldCount,
    base,
    countingAvg,
    reduction,
    droppedDiff,
    replacedCountingDiff,
    takeGrew,
    windowCountBefore,
    windowFullBefore,
    retentionHeld,
    currentHcp,
  };
}

// Erzeugt die Schritt-für-Schritt-Erklärung für die Simulator-Vorschau.
function buildPreviewExplanation(p) {
  const lines = [];
  const take = p.rule.take;
  if (p.windowFullBefore) {
    lines.push(`Das 20er-Fenster ist voll: die älteste Runde (Differenzial ${p.droppedDiff.toFixed(1)}) fällt heraus und wird durch diese ersetzt.`);
  } else {
    lines.push(`Es ist deine ${p.windowCountBefore + 1}. wertbare Runde – das Fenster (max. 20) ist noch nicht voll, es fällt keine Runde heraus.`);
  }
  if (p.reduction > 0) {
    lines.push(`Ausnahmerunde (Exceptional Score): −${p.reduction.toFixed(1)} auf alle Differenziale im Fenster.`);
  }
  if (p.wouldCount) {
    if (p.replacedCountingDiff != null) {
      lines.push(`Sie zählt und verdrängt mit ${p.diff.toFixed(1)} das bisher höchste zählende Differenzial (${p.replacedCountingDiff.toFixed(1)}) aus den besten ${take}.`);
    } else if (p.takeGrew) {
      lines.push(`Sie zählt: das Fenster ist gewachsen, jetzt zählen die besten ${take} Differenziale – deins ist dabei.`);
    } else {
      lines.push(`Sie zählt: sie gehört zu den besten ${take} Differenzialen.`);
    }
  } else {
    lines.push(`Sie zählt nicht: sie liegt nicht unter den besten ${take} – die zählenden Differenziale bleiben unverändert.`);
  }
  if (p.retentionHeld) {
    lines.push(`Bremse (Anfängerregel > 26,9): der Index bleibt bei ${p.currentHcp.toFixed(1)}, statt rechnerisch auf ${p.base.toFixed(1)} zu steigen.`);
  } else if (p.countingAvg != null) {
    const adj = p.rule.adj;
    const adjTxt = adj ? ` ${adj > 0 ? "+" : "−"} ${Math.abs(adj).toFixed(1)}` : " ± 0";
    lines.push(`Ergebnis: Ø der besten ${take} (${p.countingAvg.toFixed(1)})${adjTxt} = ${p.nextHcp.toFixed(1)}.`);
  }
  return lines;
}

function sortRoundsChronologically(a, b) {
  const byDate = (a.date||"").localeCompare(b.date||"");
  if (byDate!==0) return byDate;
  const byCreated = (a.createdAt||"").localeCompare(b.createdAt||"");
  if (byCreated!==0) return byCreated;
  return (a.id||0) - (b.id||0);
}

function getNextDate(dateString) {
  const base = dateString ? new Date(`${dateString}T12:00:00`) : new Date();
  if (Number.isNaN(base.getTime())) return new Date().toISOString().slice(0,10);
  base.setDate(base.getDate() + 1);
  return base.toISOString().slice(0,10);
}

function getLatestRoundDate(rounds) {
  return [...rounds]
    .map(round=>round.date)
    .filter(Boolean)
    .sort()
    .slice(-1)[0] || new Date().toISOString().slice(0,10);
}

function buildHandicapTimeline(rounds, startHcp) {
  const eligibleRounds = [...rounds].filter(isHcpEligible).sort(sortRoundsChronologically);
  const start = Math.min(54, Math.max(0, parseFloat(startHcp) || 54));
  // Chronologische WHS-Engine: Rohdifferenzial -> Exceptional-Score-Reduktion
  // zum Ereigniszeitpunkt -> Bremse. Dadurch stimmen auch die historischen
  // Zwischenstände und nicht nur der aktuelle Index.
  return buildIndexTimeline(eligibleRounds, start).map(step=>({
    round: step.round,
    diff: step.diff,
    hcpAfter: step.hcpAfter,
    preRoundHcp: step.preRoundHcp,
  }));
}

function deriveNineHolePhcpFactor(rounds, startHcp, courseId) {
  if (!courseId) return null;
  const timeline = buildHandicapTimeline(rounds, startHcp);
  const factors = timeline
    .filter(entry=>entry.round.courseId===courseId && parseInt(entry.round.holes)===9)
    .map(entry=>{
      const baseCourseHandicap = calcCourseHandicap(entry.preRoundHcp, entry.round.courseRating, entry.round.slopeRating, entry.round.par);
      const playingHcp = parseFloat(entry.round.playingHcp);
      if (!Number.isFinite(playingHcp) || !Number.isFinite(baseCourseHandicap) || !baseCourseHandicap) return null;
      const factor = playingHcp / baseCourseHandicap;
      return Number.isFinite(factor) && factor > 0 ? factor : null;
    })
    .filter(value=>value!==null);

  if (!factors.length) return null;

  const average = factors.reduce((sum, value)=>sum + value, 0) / factors.length;
  return {
    factor: round3(average),
    sampleSize: factors.length,
  };
}

function missingDiffReason(r) {
  if (!parseFloat(r.courseRating)) return "Course Rating fehlt";
  if (!parseFloat(r.slopeRating)) return "Slope Rating fehlt";
  if (!parseFloat(r.gbe) && !parseFloat(r.adjustedGross)) return "GBE/AGS fehlt";
  return null;
}

function hcpStatus(r) {
  if (!r.submitted) return {label:"Nicht eingereicht", dot:"#B4B2A9"};
  if (!r.markerSigned) return {label:"Marker fehlt", dot:"#E24B4A"};
  if (r.format!=="Einzel") return {label:"Nicht HCP-wirksam (Format)", dot:"#B4B2A9"};
  if (parseInt(r.holes)<18 && !r.nineHoleAllowed) return {label:"9-Loch (nicht aktiviert)", dot:"#D3D1C7"};
  return {label:"HCP-wirksam", dot:"#1D9E75"};
}

function field(label: string, children: ReactNode, hint?: string) {
  return (
    <div style={{marginBottom:14}}>
      <label style={{fontSize:12,color:"var(--color-text-secondary)",display:"block",marginBottom:4}}>
        {label}{hint && <span style={{marginLeft:6,color:"#1D9E75",fontStyle:"italic"}}>{hint}</span>}
      </label>
      {children}
    </div>
  );
}

function badge(label, bg, color) {
  return <span style={{fontSize:11,fontWeight:600,padding:"4px 9px",borderRadius:999,border:"1px solid rgba(24,38,31,0.05)",background:bg,color,whiteSpace:"nowrap",letterSpacing:"0.01em"}}>{label}</span>;
}

function formatAdjustment(adj) {
  if (!adj) return "keine";
  return adj > 0 ? `+${adj.toFixed(1)}` : adj.toFixed(1);
}

function HcpTooltip({displayHcp, estimatedHcp, roundCount, take, adjustment, countingDiffs, children}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{top:number,left:number}|null>(null);
  const triggerRef = useRef<HTMLDivElement|null>(null);
  const countingAverage = countingDiffs.length ? round1(countingDiffs.reduce((sum, diff)=>sum+diff,0) / countingDiffs.length) : null;

  useLayoutEffect(()=>{
    if (!open || !triggerRef.current) return;
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const tooltipWidth = 280;
      const margin = 8;
      let left = rect.right - tooltipWidth;
      if (left < margin) left = margin;
      if (left + tooltipWidth > window.innerWidth - margin) left = window.innerWidth - tooltipWidth - margin;
      setCoords({ top: rect.bottom + margin, left });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open]);

  return (
    <div
      ref={triggerRef}
      style={{position:"relative",display:"inline-block"}}
      onMouseEnter={()=>setOpen(true)}
      onMouseLeave={()=>setOpen(false)}
    >
      <div onClick={()=>setOpen(prev=>!prev)} style={{cursor:"help"}}>
        {children}
      </div>
      {open && coords && typeof document !== "undefined" && createPortal(
        <div
          style={{
            position:"fixed",
            top:coords.top,
            left:coords.left,
            width:280,
            background:"linear-gradient(180deg, rgba(18,33,27,0.98) 0%, rgba(24,44,35,0.96) 100%)",
            border:"1px solid rgba(255,255,255,0.12)",
            borderRadius:"var(--border-radius-md)",
            boxShadow:"0 18px 44px rgba(17, 17, 17, 0.28)",
            padding:"14px 15px",
            zIndex:1000,
            textAlign:"left",
            pointerEvents:"none",
          }}
        >
          <div style={{fontSize:12,fontWeight:700,letterSpacing:"0.08em",textTransform:"uppercase",color:"rgba(255,255,255,0.68)",marginBottom:8}}>Aktuelle HCP-Berechnung</div>
          {!estimatedHcp ? (
            <div style={{fontSize:12,lineHeight:1.55,color:"rgba(255,255,255,0.82)"}}>
              Noch keine HCP-wirksame Runde. Aktuell wird dein Start-HCP {displayHcp.toFixed(1)} angezeigt.
            </div>
          ) : (
            <>
              <div style={{fontSize:12,lineHeight:1.55,color:"rgba(255,255,255,0.82)",marginBottom:6}}>
                Von {roundCount} HCP-wirksamen Runden zählen aktuell {take} in die Berechnung.
              </div>
              <div style={{fontSize:12,lineHeight:1.55,color:"rgba(255,255,255,0.82)",marginBottom:6}}>
                WHS-Anpassung: {formatAdjustment(adjustment)}
              </div>
              {countingDiffs.length > 0 && (
                <div style={{fontSize:12,lineHeight:1.55,color:"rgba(255,255,255,0.82)",marginBottom:6}}>
                  Zählende Differentials: {countingDiffs.map(diff=>diff.toFixed(1)).join(", ")}
                </div>
              )}
              {countingAverage!==null && (
                <div style={{fontSize:12,lineHeight:1.55,color:"#fff",fontWeight:600}}>
                  Ø {countingAverage.toFixed(1)} {adjustment ? `${adjustment > 0 ? "+" : ""}${adjustment.toFixed(1)}` : "+ 0,0"} = {displayHcp.toFixed(1)}
                </div>
              )}
            </>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}

function AppNotice({title, description, tone="accent", primaryAction=null, secondaryAction}) {
  const accent = tone === "accent"
    ? {
        background:"linear-gradient(135deg, #1D9E75 0%, #0f6f55 100%)",
        text:"#fff",
        subtext:"rgba(255,255,255,0.88)",
        border:"rgba(255,255,255,0.22)",
        primaryBg:"#fff",
        primaryText:"#0f6f55",
        secondaryText:"#fff",
        secondaryBorder:"0.5px solid rgba(255,255,255,0.45)",
        shadow:"0 12px 28px rgba(15, 111, 85, 0.22)",
      }
    : {
        background:"linear-gradient(135deg, #f5f4f0 0%, #ebe7dc 100%)",
        text:"#111",
        subtext:"var(--color-text-secondary)",
        border:"var(--color-border-tertiary)",
        primaryBg:COLORS.hcp,
        primaryText:"#fff",
        secondaryText:"var(--color-text-primary)",
        secondaryBorder:`0.5px solid ${COLORS.border}`,
        shadow:"0 10px 24px rgba(17, 17, 17, 0.1)",
      };

  return (
    <div style={{
      position:"sticky",
      bottom:"calc(16px + env(safe-area-inset-bottom))",
      zIndex:tone === "accent" ? 15 : 16,
      marginTop:12,
      background:accent.background,
      color:accent.text,
      border:tone === "accent" ? "none" : `0.5px solid ${accent.border}`,
      borderRadius:"var(--border-radius-lg)",
      padding:"14px 16px",
      display:"flex",
      alignItems:"center",
      justifyContent:"space-between",
      gap:12,
      boxShadow:accent.shadow,
      flexWrap:"wrap",
    }}>
      <div style={{display:"flex",alignItems:"flex-start",gap:10,flex:"1 1 260px"}}>
        <div style={{width:10,height:10,borderRadius:"50%",background:tone === "accent" ? "#fff" : COLORS.hcp,marginTop:5,flexShrink:0}}/>
        <div>
          <div style={{fontSize:14,fontWeight:600,marginBottom:4}}>{title}</div>
          <div style={{fontSize:12,lineHeight:1.5,color:accent.subtext}}>{description}</div>
        </div>
      </div>
      <div style={{display:"flex",gap:8,alignItems:"center"}}>
        {primaryAction && (
          <button onClick={primaryAction.onClick} style={{padding:"8px 14px",borderRadius:"var(--border-radius-md)",background:accent.primaryBg,color:accent.primaryText,border:"none",cursor:"pointer",fontWeight:600,fontSize:13}}>
            {primaryAction.label}
          </button>
        )}
        <button onClick={secondaryAction.onClick} style={{padding:"8px 12px",borderRadius:"var(--border-radius-md)",background:"transparent",color:accent.secondaryText,border:accent.secondaryBorder,cursor:"pointer",fontSize:13}}>
          {secondaryAction.label}
        </button>
      </div>
    </div>
  );
}

function InstallAppPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);
  const [isIos, setIsIos] = useState(false);

  useEffect(()=>{
    const media = window.matchMedia("(display-mode: standalone)");
    const updateStandalone = () => {
      const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
      setIsStandalone(media.matches || Boolean(navigatorWithStandalone.standalone));
    };

    const userAgent = window.navigator.userAgent.toLowerCase();
    setIsIos(/iphone|ipad|ipod/.test(userAgent));
    updateStandalone();

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    media.addEventListener("change", updateStandalone);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      media.removeEventListener("change", updateStandalone);
    };
  },[]);

  if (dismissed || isStandalone) return null;
  if (!deferredPrompt && !isIos) return null;

  const install = async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    if (choice.outcome === "accepted") setDeferredPrompt(null);
  };

  return (
    <AppNotice
      title="App installieren"
      description={deferredPrompt
        ? "Installiere den Tracker auf Handy oder Desktop fuer schnellen Offline-Zugriff."
        : "Auf dem iPhone: Teilen > Zum Home-Bildschirm, dann startet der Tracker wie eine App."}
      primaryAction={deferredPrompt ? {label:"Installieren", onClick:install} : null}
      secondaryAction={{label:"Schliessen", onClick:()=>setDismissed(true)}}
    />
  );
}

function UpdateAppPrompt() {
  const [updateSW, setUpdateSW] = useState<null | ((reloadPage?: boolean) => Promise<void>)>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(()=>{
    const handleUpdateAvailable = (event: Event) => {
      const updateEvent = event as PwaUpdateEvent;
      setUpdateSW(()=>updateEvent.detail.updateSW);
      setDismissed(false);
    };

    window.addEventListener("pwa:update-available", handleUpdateAvailable);
    return () => window.removeEventListener("pwa:update-available", handleUpdateAvailable);
  },[]);

  if (!updateSW || dismissed) return null;

  const reloadApp = async () => {
    await updateSW(true);
  };

  return (
    <AppNotice
      title="Update verfuegbar"
      description="Eine neue Version des Trackers ist geladen und kann jetzt aktiviert werden."
      tone="neutral"
      primaryAction={{label:"Neu laden", onClick:reloadApp}}
      secondaryAction={{label:"Spaeter", onClick:()=>setDismissed(true)}}
    />
  );
}

function Modal({title, children, onClose, maxWidth=520}) {
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.35)",zIndex:100,display:"flex",alignItems:"flex-start",justifyContent:"center",padding:"max(24px, calc(env(safe-area-inset-top) + 16px)) max(16px, calc(env(safe-area-inset-right) + 12px)) max(24px, calc(env(safe-area-inset-bottom) + 16px)) max(16px, calc(env(safe-area-inset-left) + 12px))",overflowY:"auto"}}
      onClick={e=>{if(e.target===e.currentTarget) onClose();}}>
      <div style={{...cardStyle,padding:"20px 24px",width:"100%",maxWidth}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div style={{fontWeight:500,fontSize:16,color:"#111"}}>{title}</div>
          <button onClick={onClose} style={{background:"transparent",border:"none",cursor:"pointer",fontSize:18,color:"#888",lineHeight:1}}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// Berechnet gerundete ("schöne") Achsengrenzen und Ticks, die sich eng an die
// tatsächlichen Werte anlegen.
function niceTicks(dataMin, dataMax, count=4) {
  if (!Number.isFinite(dataMin) || !Number.isFinite(dataMax)) return {min:0,max:1,ticks:[0,1]};
  if (dataMin===dataMax) { dataMin-=1; dataMax+=1; }
  const rawStep=(dataMax-dataMin)/Math.max(1,count);
  const mag=Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm=rawStep/mag;
  const step=(norm<1.5?1:norm<3?2:norm<7?5:10)*mag;
  const min=Math.floor(dataMin/step)*step;
  const max=Math.ceil(dataMax/step)*step;
  const ticks=[];
  for (let v=min; v<=max+step*0.5; v+=step) ticks.push(Math.round(v*100)/100);
  return {min, max, ticks};
}

// Gemeinsame, responsive Linien-Chart-Basis mit Grid, projizierter (gestrichelter)
// Linie und – im interaktiven Modus – Tooltips beim Überfahren/Antippen der Punkte.
function LineChart({points, lineColor=COLORS.hcp, projectedColor="#C56B1A", width=680, height=200, interactive=false, valueFormat=(v)=>`${v}`}) {
  const [hover, setHover] = useState(null);
  const pad={t:16,r:20,b:32,l:44};
  const vals=points.map(p=>p.value);
  if (!vals.length) return null;
  // y-Achse passt sich an die (gefensterten) Werte an – mit gerundeten Grenzen/Ticks.
  const {min, max, ticks}=niceTicks(Math.min(...vals), Math.max(...vals), 4);
  const fmtTick=v=>Number.isInteger(v)?String(v):v.toFixed(1);
  const times=points.map(p=>p.date);
  const tMin=Math.min(...times), tMax=Math.max(...times);
  const sx=t=>tMax===tMin ? pad.l+(width-pad.l-pad.r)/2 : pad.l+((t-tMin)/(tMax-tMin))*(width-pad.l-pad.r);
  const sy=v=>pad.t+((max-v)/((max-min)||1))*(height-pad.t-pad.b);
  const firstProjected = points.findIndex(p=>p.projected);
  const actualPts=(firstProjected===-1 ? points : points.slice(0, firstProjected)).map(p=>`${sx(p.date)},${sy(p.value)}`).join(" ");
  const projectedPts=firstProjected===-1 ? "" : points.slice(Math.max(0,firstProjected-1)).map(p=>`${sx(p.date)},${sy(p.value)}`).join(" ");
  const fmt=t=>new Date(t).toLocaleDateString("de-DE",{day:"2-digit",month:"2-digit",year:"2-digit"});
  const hp = hover!==null ? points[hover] : null;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{width:"100%",height:"auto",display:"block"}} onMouseLeave={()=>setHover(null)}>
      {ticks.map((v,i)=>(
        <g key={i}>
          <line x1={pad.l} x2={width-pad.r} y1={sy(v)} y2={sy(v)} stroke="#D3D1C7" strokeWidth={0.5}/>
          <text x={pad.l-6} y={sy(v)+4} fontSize={10} textAnchor="end" fill="#888">{fmtTick(v)}</text>
        </g>
      ))}
      {hp && <line x1={sx(hp.date)} x2={sx(hp.date)} y1={pad.t} y2={height-pad.b} stroke="#B4B2A9" strokeWidth={0.5} strokeDasharray="3 3"/>}
      {actualPts && <polyline points={actualPts} fill="none" stroke={lineColor} strokeWidth={1.8}/>}
      {projectedPts && <polyline points={projectedPts} fill="none" stroke={projectedColor} strokeWidth={1.8} strokeDasharray="5 4"/>}
      {points.map((p,i)=>(
        <circle key={i} cx={sx(p.date)} cy={sy(p.value)} r={hover===i?4.5:3} fill={p.projected?projectedColor:(p.color||lineColor)}/>
      ))}
      {interactive && points.map((p,i)=>(
        <circle key={`hit${i}`} cx={sx(p.date)} cy={sy(p.value)} r={14} fill="transparent" style={{cursor:"pointer"}} onMouseEnter={()=>setHover(i)} onClick={()=>setHover(i)}/>
      ))}
      <text x={pad.l} y={height-4} fontSize={10} fill="#888">{fmt(tMin)}</text>
      {tMax!==tMin && <text x={width-pad.r} y={height-4} fontSize={10} textAnchor="end" fill="#888">{fmt(tMax)}</text>}
      {hp && (()=>{
        const tw=104, th=34;
        let tx=sx(hp.date)+10; if (tx+tw>width-pad.r) tx=sx(hp.date)-10-tw; if (tx<pad.l) tx=pad.l;
        let ty=sy(hp.value)-th-8; if (ty<pad.t) ty=sy(hp.value)+8;
        return (
          <g pointerEvents="none">
            <rect x={tx} y={ty} width={tw} height={th} rx={6} fill="rgba(18,33,27,0.96)"/>
            <text x={tx+9} y={ty+15} fontSize={11} fontWeight={600} fill="#fff">{valueFormat(hp.value)}</text>
            <text x={tx+9} y={ty+28} fontSize={9} fill="rgba(255,255,255,0.72)">{fmt(hp.date)}</text>
          </g>
        );
      })()}
    </svg>
  );
}

function ScoreChart({data, projectedStartIndex=null, width=680, height=200, interactive=false}) {
  const visible=data.filter(d=>d.diff!==null);
  const points=visible.map((d,i)=>({
    date:new Date(d.date).getTime(),
    value:d.diff,
    color:d.mode==="Stableford"?COLORS.stableford:COLORS.stroke,
    projected:projectedStartIndex!==null && i>=projectedStartIndex,
  }));
  if (!points.length) return null;
  return <LineChart points={points} lineColor={COLORS.hcp} width={width} height={height} interactive={interactive} valueFormat={v=>v.toFixed(1)}/>;
}

function HcpTrendChart({trend, projectedStartIndex=null, width=680, height=180, interactive=false}) {
  const points=trend.map((t,i)=>({
    date:new Date(t.date).getTime(),
    value:t.hcp,
    projected:projectedStartIndex!==null && i>=projectedStartIndex,
  }));
  if (!points.length) return null;
  return <LineChart points={points} lineColor={COLORS.hcp} width={width} height={height} interactive={interactive} valueFormat={v=>v.toFixed(1)}/>;
}

// Fenster-Regler für die Charts: nach Runden (max 20) oder Zeitraum (max 365 Tage).
function ChartWindowControl({win, setWin}) {
  const btn=(active,label,onClick)=>(
    <button key={label} onClick={onClick} style={{fontSize:11,padding:"3px 9px",borderRadius:"var(--border-radius-md)",background:active?COLORS.hcp:"transparent",color:active?"#fff":"var(--color-text-secondary)",border:`0.5px solid ${active?COLORS.hcp:"var(--color-border-tertiary)"}`,cursor:"pointer"}}>{label}</button>
  );
  return (
    <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginBottom:12}}>
      <span style={{fontSize:12,color:"var(--color-text-secondary)"}}>Fenster:</span>
      <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
        {[5,10,20].map(n=>btn(win.mode==="rounds"&&win.size===n, `${n} Runden`, ()=>setWin({mode:"rounds",size:n})))}
      </div>
      <span style={{fontSize:11,color:"var(--color-border-secondary)"}}>·</span>
      <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
        {[[90,"3 Mon."],[180,"6 Mon."],[365,"12 Mon."]].map(([d,l])=>btn(win.mode==="days"&&win.size===d, l, ()=>setWin({mode:"days",size:d})))}
      </div>
    </div>
  );
}

function HcpRoundsTable({rounds, diffByRoundId, simulatedRoundIds=new Set()}) {
  const n = Math.min(rounds.length, 20);
  const take = n > 0 ? getHandicapRule(n).take : 0;
  const withDiffs = [...rounds].reverse().slice(0,20).map(r=>({r, diff:diffByRoundId.get(r.id) ?? null}));
  const counting = new Set(
    [...withDiffs].filter(x=>x.diff!==null).sort((a,b)=>a.diff-b.diff).slice(0,take).map(x=>x.r.id)
  );
  return (
    <div style={{marginBottom:24}}>
      <div style={{fontSize:14,fontWeight:500,marginBottom:4}}>HCP-wirksame Runden</div>
      <div style={{fontSize:12,color:"var(--color-text-secondary)",marginBottom:10}}>
        {n} Runden · beste {take} fließen in die Berechnung ein
      </div>
      <div style={{border:"0.5px solid var(--color-border-tertiary)",borderRadius:"var(--border-radius-md)",overflow:"hidden"}}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 60px 40px 90px",background:"var(--color-background-secondary)",padding:"6px 12px",fontSize:11,color:"var(--color-text-secondary)",fontWeight:500,gap:8}}>
          <span>Platz / Datum</span>
          <span style={{textAlign:"right"}}>Diff</span>
          <span style={{textAlign:"center"}}>zählt</span>
          <span style={{textAlign:"right"}}>Format</span>
        </div>
        {withDiffs.map(({r, diff}, i)=>{
          const counts = counting.has(r.id);
          const simulated = simulatedRoundIds.has(r.id);
          const background = simulated
            ? counts ? "linear-gradient(180deg, #fff3e4 0%, #ffecd2 100%)" : i%2===0 ? "#fff8ef" : "#fff4e4"
            : counts ? "#E1F5EE" : i%2===0 ? "#fff" : "var(--color-background-secondary)";
          return (
            <div key={r.id} style={{
              display:"grid",gridTemplateColumns:"1fr 60px 40px 90px",gap:8,
              padding:"8px 12px",alignItems:"center",
              background,
              borderTop: i>0 ? "0.5px solid var(--color-border-tertiary)" : "none"
            }}>
              <div>
                <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                  <div style={{fontSize:13,fontWeight:counts?500:400,color:"var(--color-text-primary)"}}>{r.courseName}</div>
                  {isGolfDeImportedRound(r) && badge("golf.de", "#E1F1FB", "#0C447C")}
                </div>
                <div style={{fontSize:11,color:"var(--color-text-secondary)"}}>{r.date} · {r.holes} Loch · PHCP {r.playingHcp}</div>
              </div>
              <div style={{fontSize:14,fontWeight:500,textAlign:"right",color:counts?"#1D9E75":"var(--color-text-primary)"}}>
                {diff!==null ? diff : <span title={missingDiffReason(r)||""} style={{color:"#E24B4A",fontSize:12,cursor:"help"}}>fehlt{missingDiffReason(r)?" ⚠":""}​</span>}
              </div>
              <div style={{textAlign:"center",color:"#1D9E75",fontWeight:500}}>{counts?"✓":""}</div>
              <div style={{textAlign:"right"}}>
                {badge(r.mode, r.mode==="Stableford"?"#EEEDFE":"#E6F1FB", r.mode==="Stableford"?"#3C3489":"#0C447C")}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProfileForm({profile, onSave, isSetup=false}) {
  const [p, setP] = useState({name:profile.name||"", startHcp:profile.startHcp??54});
  const set = (k,v) => setP(prev=>({...prev,[k]:v}));
  return (
    <div style={{...cardStyle,padding:"20px 24px"}}>
      {isSetup && <p style={{fontSize:14,color:"var(--color-text-secondary)",marginBottom:16}}>Einmal einrichten – wird für alle Runden verwendet.</p>}
      {field("Dein Name", <input style={inp} value={p.name} onChange={e=>set("name",e.target.value)} placeholder="z.B. Max Mustermann"/>)}
      {field("Start-HCP Index", <input type="number" step="0.1" style={inp} value={p.startHcp} onChange={e=>set("startHcp",parseFloat(e.target.value))}/>, "(Standard: 54)")}
      <button onClick={()=>{ if(!p.name) return alert("Bitte Namen eingeben"); onSave(p); }}
        style={{padding:"9px 18px",borderRadius:"var(--border-radius-md)",background:COLORS.hcp,color:"#fff",border:"none",cursor:"pointer",fontWeight:500,fontSize:14}}>
        {isSetup?"Loslegen":"Speichern"}
      </button>
    </div>
  );
}

function RoundForm({initial, courses, currentHcp, onSave, onCancel}) {
  const [r, setR] = useState(initial);
  const set = (k,v) => setR(prev=>({...prev,[k]:v}));
  const eligible = isHcpEligible(r);
  const cr=parseFloat(r.courseRating), sr=parseFloat(r.slopeRating);
  const par=parseInt(r.par)||36, phcp=parseFloat(r.playingHcp)||0;
  const selectedCourse = courses.find(x=>x.id===parseInt(r.courseId));
  const phcpSuggestion = useMemo(()=>calcPlayingHcpFromCourse(currentHcp, {
    courseRating:r.courseRating,
    slopeRating:r.slopeRating,
    par:r.par,
    nineHolePhcpFactor:selectedCourse?.nineHolePhcpFactor,
  }, r.holes), [currentHcp, r.courseRating, r.slopeRating, r.par, r.holes, selectedCourse?.nineHolePhcpFactor]);

  const prefill = c => setR(prev=>({...prev,courseId:c.id,courseName:c.name,courseRating:c.courseRating,slopeRating:c.slopeRating,par:c.par}));

  const handleSave = () => {
    if (!r.date) return alert("Datum erforderlich");
    const final = {...r};
    if (final.courseId) {
      const c = courses.find(x=>x.id===parseInt(final.courseId));
      if (c) { final.courseName=c.name; final.courseRating=c.courseRating; final.slopeRating=c.slopeRating; final.par=c.par; }
    }
    if (!final.courseName) return alert("Bitte Platzname angeben");
    if (final.gbe) final.gbe = parseInt(final.gbe);
    const par2=parseInt(final.par)||36, phcp2=parseFloat(final.playingHcp)||0;
    const pts2=parseInt(final.stablefordPoints);
    if (final.mode==="Stableford" && Number.isFinite(pts2)) {
      final.adjustedGross = calcAdjustedGrossFromStableford({ par:par2, playingHcp:phcp2, holes:final.holes, stablefordPoints:pts2 });
    }
    onSave(final);
  };

  return (
    <div>
      {field("Datum", <input type="date" style={inp} value={r.date||""} onChange={e=>set("date",e.target.value)}/>)}
      {field("Platz aus Datenbank", <select style={sel} value={r.courseId||""} onChange={e=>{const c=courses.find(x=>x.id===parseInt(e.target.value));if(c) prefill(c);}}>
        <option value="">– wählen oder manuell –</option>
        {courses.map(c=><option key={c.id} value={c.id}>{c.name} (CR {c.courseRating} / SR {c.slopeRating})</option>)}
      </select>)}
      {field("Platzname", <input style={inp} value={r.courseName||""} onChange={e=>set("courseName",e.target.value)} placeholder="z.B. GC Bergisch Land"/>)}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
        {field("Course Rating", <input type="number" step="0.1" style={inp} value={r.courseRating||""} onChange={e=>set("courseRating",parseFloat(e.target.value))} placeholder="36.0"/>)}
        {field("Slope Rating", <input type="number" style={inp} value={r.slopeRating||""} onChange={e=>set("slopeRating",parseInt(e.target.value))} placeholder="130"/>)}
        {field("Par", <input type="number" style={inp} value={r.par||""} onChange={e=>set("par",parseInt(e.target.value))} placeholder="37"/>)}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
        {field("Wertungsform", <select style={sel} value={r.mode||"Stableford"} onChange={e=>set("mode",e.target.value)}>
          {MODES.map(m=><option key={m}>{m}</option>)}
        </select>)}
        {field("Format", <select style={sel} value={r.format||"Einzel"} onChange={e=>set("format",e.target.value)}>
          {FORMATS.map(f=><option key={f}>{f}</option>)}
        </select>)}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
        {field("Anzahl Löcher", <select style={sel} value={r.holes||18} onChange={e=>set("holes",parseInt(e.target.value))}>
          <option value={18}>18 Loch</option>
          <option value={9}>9 Loch</option>
        </select>)}
        {field("Playing HCP (Spielvorgabe)", <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:8}}>
          <input type="number" step="0.1" style={inp} value={r.playingHcp||""} onChange={e=>set("playingHcp",parseFloat(e.target.value))} placeholder="31"/>
          <button type="button" onClick={()=>phcpSuggestion!==null && set("playingHcp", phcpSuggestion)} style={{padding:"0 12px",borderRadius:"var(--border-radius-md)",border:"1px solid var(--color-border-secondary)",background:"rgba(255,255,255,0.92)",cursor:phcpSuggestion!==null?"pointer":"not-allowed",color:"var(--color-text-primary)",fontSize:12,fontWeight:600,opacity:phcpSuggestion!==null?1:0.5}}>
            Auto
          </button>
        </div>, phcpSuggestion!==null ? `Vorschlag aus HCP ${currentHcp.toFixed(1)}: ${phcpSuggestion}` : parseInt(r.holes)===9 ? "absolute Schlaege fuer 9 Loch" : undefined)}
      </div>
      {parseInt(r.holes)===9 && (
        <div style={{marginBottom:14}}>
          <label style={{display:"flex",alignItems:"center",gap:8,fontSize:13,cursor:"pointer"}}>
            <input type="checkbox" checked={r.nineHoleAllowed||false} onChange={e=>set("nineHoleAllowed",e.target.checked)}/>
            9-Loch HCP-wirksam (WHS seit April 2024)
          </label>
        </div>
      )}
      {r.mode==="Stableford" && (()=>{
        const pts=parseInt(r.stablefordPoints);
        const autoAGS=Number.isFinite(pts)?calcAdjustedGrossFromStableford({ par, playingHcp:phcp, holes:r.holes, stablefordPoints:pts }):null;
        return (
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            {field("Stableford Punkte", <input type="number" style={inp} value={r.stablefordPoints||""} onChange={e=>{
              const p=parseInt(e.target.value);
              const upd: Record<string, number>={stablefordPoints:p};
              if(Number.isFinite(p)) upd.adjustedGross=calcAdjustedGrossFromStableford({ par, playingHcp:phcp, holes:r.holes, stablefordPoints:p });
              setR(prev=>({...prev,...upd}));
            }} placeholder="23"/>)}
            {field("AGS (berechnet)", <input type="number" style={{...inp,background:"#f8f8f8"}} value={r.adjustedGross||""} onChange={e=>set("adjustedGross",parseInt(e.target.value))}/>, autoAGS?"auto":"")}
          </div>
        );
      })()}
      {r.mode==="Stroke Play" && field("Adjusted Gross Score", <input type="number" style={inp} value={r.adjustedGross||""} onChange={e=>set("adjustedGross",parseInt(e.target.value))} placeholder="92"/>)}
      {field(
        parseInt(r.holes)===9 ? "GBE von golf.de (überschreibt AGS)" : "GBE von golf.de (optional)",
        <input type="number" style={{...inp,background:r.gbe?"#E1F5EE":"#fff"}} value={r.gbe||""} onChange={e=>set("gbe",e.target.value?parseInt(e.target.value):"")} placeholder="z.B. 48"/>,
        r.gbe?"wird verwendet":""
      )}
      <div style={{display:"flex",gap:24,marginBottom:14}}>
        <label style={{display:"flex",alignItems:"center",gap:8,fontSize:13,cursor:"pointer"}}>
          <input type="checkbox" checked={r.submitted||false} onChange={e=>set("submitted",e.target.checked)}/>
          Eingereicht (DGVnet)
        </label>
        <label style={{display:"flex",alignItems:"center",gap:8,fontSize:13,cursor:"pointer"}}>
          <input type="checkbox" checked={r.markerSigned||false} onChange={e=>set("markerSigned",e.target.checked)}/>
          Marker unterschrieben
        </label>
      </div>
      <div style={{padding:"10px 14px",borderRadius:"var(--border-radius-md)",background:eligible?"#E1F5EE":"#F1EFE8",marginBottom:16,fontSize:13,color:eligible?"#085041":"#5F5E5A"}}>
        {eligible?"✓ Diese Runde wird HCP-wirksam eingehen.":"✗ Diese Runde ist nicht HCP-wirksam."}
        {!r.submitted&&" → Runde einreichen."}
        {r.submitted&&!r.markerSigned&&" → Marker-Unterschrift fehlt."}
        {r.submitted&&r.markerSigned&&r.format!=="Einzel"&&" → Nur Einzel ist HCP-wirksam."}
        {parseInt(r.holes)===9&&!r.nineHoleAllowed&&" → Checkbox '9-Loch HCP-wirksam' aktivieren."}
      </div>
      <div style={{display:"flex",gap:8}}>
        <button onClick={handleSave} style={{padding:"9px 18px",borderRadius:"var(--border-radius-md)",background:COLORS.hcp,color:"#fff",border:"none",cursor:"pointer",fontWeight:500,fontSize:14}}>Speichern</button>
        <button onClick={onCancel} style={{padding:"9px 18px",borderRadius:"var(--border-radius-md)",background:"transparent",border:"0.5px solid var(--color-border-tertiary)",cursor:"pointer",fontSize:14,color:"var(--color-text-primary)"}}>Abbrechen</button>
      </div>
    </div>
  );
}

function CourseForm({initial, rounds, startHcp, onSave, onCancel}) {
  const [c, setC] = useState(normalizeCourse(initial));
  const set = (k,v) => setC(prev=>({...prev,[k]:v}));
  const learnedFactor = useMemo(()=>deriveNineHolePhcpFactor(rounds, startHcp, c.id), [rounds, startHcp, c.id]);

  return (
    <div>
      {field("Platzname", <input style={inp} value={c.name||""} onChange={e=>set("name",e.target.value)} placeholder="GC Bergisch Land"/>)}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
        {field("Course Rating", <input type="number" step="0.1" style={inp} value={c.courseRating||""} onChange={e=>set("courseRating",parseFloat(e.target.value))} placeholder="36.0"/>)}
        {field("Slope Rating", <input type="number" style={inp} value={c.slopeRating||""} onChange={e=>set("slopeRating",parseInt(e.target.value))} placeholder="130"/>)}
        {field("Par", <input type="number" style={inp} value={c.par||""} onChange={e=>set("par",parseInt(e.target.value))} placeholder="37"/>)}
      </div>
      {field("Abschlag / Tee", <select style={sel} value={c.tee||"Gelb"} onChange={e=>set("tee",e.target.value)}>
        {TEES.map(t=><option key={t}>{t}</option>)}
      </select>)}
      {field("9-Loch PHCP-Faktor", <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:8}}>
        <input type="number" step="0.001" style={inp} value={c.nineHolePhcpFactor??0.5} onChange={e=>set("nineHolePhcpFactor", parseFloat(e.target.value))} placeholder="0.500"/>
        <button type="button" onClick={()=>learnedFactor && set("nineHolePhcpFactor", learnedFactor.factor)} style={{padding:"0 12px",borderRadius:"var(--border-radius-md)",border:"1px solid var(--color-border-secondary)",background:"rgba(255,255,255,0.92)",cursor:learnedFactor?"pointer":"not-allowed",color:"var(--color-text-primary)",fontSize:12,fontWeight:600,opacity:learnedFactor?1:0.5}}>
          Ableiten
        </button>
      </div>, learnedFactor ? `aus ${learnedFactor.sampleSize} Runde${learnedFactor.sampleSize===1?"":"n"}: ${learnedFactor.factor}` : "9-Loch PHCP = Course Handicap × Faktor")}
      {field("Notizen", <textarea style={{...inp,resize:"vertical",minHeight:60}} value={c.notes||""} onChange={e=>set("notes",e.target.value)} placeholder="z.B. Heimatplatz"/>)}
      <div style={{display:"flex",gap:8}}>
        <button onClick={()=>{if(!c.name) return alert("Name erforderlich"); onSave(c);}}
          style={{padding:"9px 18px",borderRadius:"var(--border-radius-md)",background:COLORS.hcp,color:"#fff",border:"none",cursor:"pointer",fontWeight:500,fontSize:14}}>Speichern</button>
        <button onClick={onCancel} style={{padding:"9px 18px",borderRadius:"var(--border-radius-md)",background:"transparent",border:"0.5px solid var(--color-border-tertiary)",cursor:"pointer",fontSize:14,color:"var(--color-text-primary)"}}>Abbrechen</button>
      </div>
    </div>
  );
}

function RoundRow({round:r, onEdit=()=>{}, onDelete=()=>{}, compact=false, counting=false, diffByRoundId}) {
  const status=hcpStatus(r);
  const diff=diffByRoundId.get(r.id) ?? null;
  const simulated = Boolean(r.simulated);
  const imported = isGolfDeImportedRound(r);
  const borderColor = simulated ? "rgba(197,107,26,0.34)" : counting ? "rgba(29,158,117,0.38)" : "var(--color-border-tertiary)";
  const background = simulated
    ? counting ? "linear-gradient(180deg, #fff1df 0%, #ffe7c5 100%)" : "linear-gradient(180deg, rgba(255,248,239,0.98) 0%, rgba(255,240,218,0.98) 100%)"
    : counting ? "linear-gradient(180deg, #ecfbf4 0%, #e3f6ee 100%)" : "rgba(255,255,255,0.9)";
  return (
    <div style={{display:"flex",alignItems:"center",gap:12,padding:"12px 14px",borderRadius:"var(--border-radius-md)",border:`1px solid ${borderColor}`,background,boxShadow:"var(--shadow-soft)",marginBottom:10}}>
      <div style={{width:10,height:10,borderRadius:"50%",background:simulated?"#C56B1A":status.dot,flexShrink:0}}/>
      <div style={{flex:1,minWidth:0}}>
        <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
          <span style={{fontWeight:500,fontSize:14,color:"var(--color-text-primary)"}}>{r.courseName||"Unbekannter Platz"}</span>
          {simulated && badge("Simulation", "#fff1df", "#9a5314")}
          {imported && badge("golf.de Import", "#E1F1FB", "#0C447C")}
          {badge(r.mode,r.mode==="Stableford"?"#EEEDFE":"#E6F1FB",r.mode==="Stableford"?"#3C3489":"#0C447C")}
          {badge(status.label,status.dot==="#1D9E75"?"#E1F5EE":"#F1EFE8",status.dot==="#1D9E75"?"#085041":"#5F5E5A")}
        </div>
        <div style={{fontSize:12,color:"var(--color-text-secondary)",marginTop:2}}>
          {r.date} · {r.holes} Loch · CR {r.courseRating} / SR {r.slopeRating}
          {r.gbe?` · GBE ${r.gbe}`:r.adjustedGross?` · AGS ${r.adjustedGross}`:""}
          {imported && r.sourceRoundId ? ` · golf.de #${r.sourceRoundId}` : ""}
          {diff!==null?` · Diff: ${diff}`:""}
        </div>
      </div>
      {!compact && (
        <div style={{display:"flex",gap:6}}>
          <button onClick={onEdit} style={{padding:"4px 10px",borderRadius:"var(--border-radius-md)",border:"0.5px solid var(--color-border-tertiary)",background:"transparent",cursor:"pointer",fontSize:12,color:"var(--color-text-primary)"}}>Bearbeiten</button>
          <button onClick={onDelete} style={{padding:"4px 10px",borderRadius:"var(--border-radius-md)",border:"0.5px solid #E24B4A",background:"transparent",cursor:"pointer",fontSize:12,color:"#E24B4A"}}>Löschen</button>
        </div>
      )}
    </div>
  );
}

function RoundList({rounds, courses, onNew, onEdit, onDelete, countingIds, diffByRoundId}) {
  const [filter, setFilter] = useState("all");
  const [sortKey, setSortKey] = useState("date"); // "date" | "sd"
  const [sortDir, setSortDir] = useState("desc");  // "asc" | "desc"
  const hcpEligible = rounds.filter(isHcpEligible);
  const take = hcpEligible.length > 0 ? getHandicapRule(Math.min(hcpEligible.length, 20)).take : 0;

  const toggleSort = (key) => {
    if (sortKey===key) { setSortDir(d=>d==="asc"?"desc":"asc"); return; }
    setSortKey(key);
    // SD/Brutto: niedrigstes (bestes) zuerst; Platz: A→Z; Datum: neuestes zuerst
    setSortDir((key==="sd"||key==="gross"||key==="course") ? "asc" : "desc");
  };

  const filtered = rounds.filter(r=>{
    if (filter==="hcp") return isHcpEligible(r);
    if (filter==="no_hcp") return !isHcpEligible(r);
    if (filter==="counting") return countingIds.has(r.id);
    return true;
  });

  const dir = sortDir==="asc" ? 1 : -1;
  // Numerische Sortierung; fehlende Werte (null) landen immer am Ende.
  const byNumber = (va, vb) => {
    const aN=va===null||va===undefined, bN=vb===null||vb===undefined;
    if (aN && bN) return null;
    if (aN) return 1;
    if (bN) return -1;
    return va!==vb ? (va-vb)*dir : null;
  };
  const visible = [...filtered].sort((a,b)=>{
    if (sortKey==="sd") {
      const cmp=byNumber(diffByRoundId.get(a.id), diffByRoundId.get(b.id));
      if (cmp!==null) return cmp;
      return (b.date||"").localeCompare(a.date||"");
    }
    if (sortKey==="gross") {
      const cmp=byNumber(getGrossScore(a), getGrossScore(b));
      if (cmp!==null) return cmp;
      return (b.date||"").localeCompare(a.date||"");
    }
    if (sortKey==="course") {
      const cmp=(a.courseName||"").localeCompare(b.courseName||"");
      if (cmp!==0) return cmp*dir;
      return (b.date||"").localeCompare(a.date||"");
    }
    const cmp=(a.date||"").localeCompare(b.date||"");
    if (cmp!==0) return cmp*dir;
    return ((a.id||0)-(b.id||0))*dir;
  });

  const arrow = key => sortKey===key ? (sortDir==="asc" ? " ↑" : " ↓") : "";
  const sortBtn = (key,label)=>(
    <button key={key} onClick={()=>toggleSort(key)} style={{fontSize:12,padding:"4px 10px",borderRadius:"var(--border-radius-md)",background:sortKey===key?"rgba(29,158,117,0.12)":"transparent",color:sortKey===key?COLORS.hcp:"var(--color-text-secondary)",border:`0.5px solid ${sortKey===key?COLORS.hcp:"var(--color-border-tertiary)"}`,cursor:"pointer",fontWeight:sortKey===key?600:400}}>{label}{arrow(key)}</button>
  );

  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,gap:12,flexWrap:"wrap"}}>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {[["all","Alle"],["hcp","HCP-wirksam"],["counting",`Zählt aktuell (${take})`],["no_hcp","Nicht wirksam"]].map(([v,l])=>(
            <button key={v} onClick={()=>setFilter(v)} style={{fontSize:12,padding:"4px 10px",borderRadius:"var(--border-radius-md)",background:filter===v?COLORS.hcp:"transparent",color:filter===v?"#fff":"var(--color-text-secondary)",border:`0.5px solid ${filter===v?COLORS.hcp:"var(--color-border-tertiary)"}`,cursor:"pointer"}}>{l}</button>
          ))}
        </div>
        <button onClick={onNew} style={{padding:"8px 14px",borderRadius:"var(--border-radius-md)",background:COLORS.hcp,color:"#fff",border:"none",cursor:"pointer",fontSize:13,fontWeight:500}}>+ Neue Runde</button>
      </div>
      <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:14,flexWrap:"wrap"}}>
        <span style={{fontSize:12,color:"var(--color-text-secondary)"}}>Sortieren:</span>
        {sortBtn("date","Datum")}
        {sortBtn("sd","SD")}
        {sortBtn("gross","Brutto")}
        {sortBtn("course","Platz")}
      </div>
      {visible.length===0 && <div style={{color:"var(--color-text-secondary)",fontSize:14,padding:"24px 0"}}>Keine Runden gefunden.</div>}
      {visible.map(r=><RoundRow key={r.id} round={r} onEdit={()=>onEdit(r)} onDelete={()=>onDelete(r.id)} counting={countingIds.has(r.id)} diffByRoundId={diffByRoundId}/>)}
    </div>
  );
}

function CourseList({courses, onNew, onEdit}) {
  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <div style={{fontSize:13,color:"var(--color-text-secondary)"}}>{courses.length} Plätze gespeichert</div>
        <button onClick={onNew} style={{padding:"8px 14px",borderRadius:"var(--border-radius-md)",background:COLORS.hcp,color:"#fff",border:"none",cursor:"pointer",fontSize:13,fontWeight:500}}>+ Neuer Platz</button>
      </div>
      {courses.length===0 && <div style={{color:"var(--color-text-secondary)",fontSize:14,padding:"24px 0"}}>Noch keine Plätze angelegt.</div>}
      {courses.map(c=>(
        <div key={c.id} style={{padding:"12px 14px",borderRadius:"var(--border-radius-md)",border:"1px solid var(--color-border-tertiary)",background:"rgba(255,255,255,0.9)",boxShadow:"var(--shadow-soft)",marginBottom:10,display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,flexWrap:"wrap"}}>
          <div>
            <div style={{fontWeight:500,fontSize:14,color:"var(--color-text-primary)"}}>{c.name}</div>
            <div style={{fontSize:12,color:"var(--color-text-secondary)"}}>CR {c.courseRating} · SR {c.slopeRating} · Par {c.par} · {c.tee} · 9L PHCP × {getNineHolePhcpFactor(c).toFixed(3)}</div>
          </div>
          <button onClick={()=>onEdit(c)} style={{padding:"4px 10px",borderRadius:"var(--border-radius-md)",border:"0.5px solid var(--color-border-tertiary)",background:"transparent",cursor:"pointer",fontSize:12,color:"var(--color-text-primary)"}}>Bearbeiten</button>
        </div>
      ))}
    </div>
  );
}

function SimulatorRoundForm({initial, courses, currentHcp, onSave, onCancel}) {
  const [r, setR] = useState(initial);
  const set = (k,v) => setR(prev=>({...prev,[k]:v}));
  const cr=parseFloat(r.courseRating), sr=parseFloat(r.slopeRating);
  const par=parseInt(r.par)||36, phcp=parseFloat(r.playingHcp)||0;
  const selectedCourse = courses.find(x=>x.id===parseInt(r.courseId));
  const phcpSuggestion = useMemo(()=>calcPlayingHcpFromCourse(currentHcp, {
    courseRating:r.courseRating,
    slopeRating:r.slopeRating,
    par:r.par,
    nineHolePhcpFactor:selectedCourse?.nineHolePhcpFactor,
  }, r.holes), [currentHcp, r.courseRating, r.slopeRating, r.par, r.holes, selectedCourse?.nineHolePhcpFactor]);

  const prefill = course => setR(prev=>({
    ...prev,
    courseId:course.id,
    courseName:course.name,
    courseRating:course.courseRating,
    slopeRating:course.slopeRating,
    par:course.par,
    playingHcp:calcPlayingHcpFromCourse(currentHcp, course, prev.holes) ?? prev.playingHcp,
  }));

  const projectedGross = useMemo(()=>{
    if (r.mode!=="Stableford") return parseInt(r.adjustedGross);
    return calcAdjustedGrossFromStableford(r);
  }, [r]);

  const preview = useMemo(()=>{
    if (!projectedGross) return null;
    const simulation = buildProjectedHandicap({
      recentDiffs:initial.recentDiffs || [],
      currentHcp,
      round:{
        holes:r.holes,
        mode:r.mode,
        courseRating:r.courseRating,
        slopeRating:r.slopeRating,
        par:r.par,
        playingHcp:r.playingHcp,
        adjustedGross:projectedGross,
      }
    });
    return simulation;
  }, [initial.recentDiffs, currentHcp, r, projectedGross]);

  const handleSave = () => {
    if (!r.date) return alert("Datum erforderlich");
    if (!r.courseName) return alert("Bitte Platzname angeben");
    const final = {...r};
    if (final.courseId) {
      const c = courses.find(x=>x.id===parseInt(final.courseId));
      if (c) {
        final.courseName=c.name;
        final.courseRating=c.courseRating;
        final.slopeRating=c.slopeRating;
        final.par=c.par;
      }
    }
    if (final.mode==="Stableford" && projectedGross) final.adjustedGross = projectedGross;
    onSave(final);
  };

  return (
    <div>
      {field("Datum", <input type="date" style={inp} value={r.date||""} onChange={e=>set("date",e.target.value)}/>)}
      {field("Platz aus Datenbank", <select style={sel} value={r.courseId||""} onChange={e=>{const c=courses.find(x=>x.id===parseInt(e.target.value)); if (c) prefill(c);}}>
        <option value="">– waehlen oder manuell –</option>
        {courses.map(c=><option key={c.id} value={c.id}>{c.name} (CR {c.courseRating} / SR {c.slopeRating})</option>)}
      </select>)}
      {field("Platzname", <input style={inp} value={r.courseName||""} onChange={e=>set("courseName",e.target.value)} placeholder="z.B. Pulheim City"/>)}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
        {field("Course Rating", <input type="number" step="0.1" style={inp} value={r.courseRating||""} onChange={e=>set("courseRating",parseFloat(e.target.value))} placeholder="30.1"/>)}
        {field("Slope Rating", <input type="number" style={inp} value={r.slopeRating||""} onChange={e=>set("slopeRating",parseInt(e.target.value))} placeholder="100"/>)}
        {field("Par", <input type="number" style={inp} value={r.par||""} onChange={e=>set("par",parseInt(e.target.value))} placeholder="32"/>)}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
        {field("Loecher", <select style={sel} value={r.holes} onChange={e=>set("holes", parseInt(e.target.value))}>
          <option value={9}>9 Loch</option>
          <option value={18}>18 Loch</option>
        </select>)}
        {field("Wertung", <select style={sel} value={r.mode} onChange={e=>set("mode", e.target.value)}>
          <option value="Stableford">Stableford</option>
          <option value="Stroke Play">Zaehspiel</option>
        </select>)}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:8}}>
        <div>{field("Playing HCP", <input type="number" step="0.1" style={inp} value={r.playingHcp||""} onChange={e=>set("playingHcp",parseFloat(e.target.value))} placeholder={currentHcp.toFixed(1)}/>, phcpSuggestion!==null ? `Vorschlag aus HCP ${currentHcp.toFixed(1)}: ${phcpSuggestion}` : r.holes===9 ? "absolute Schlaege fuer 9 Loch" : undefined)}</div>
        <button type="button" onClick={()=>phcpSuggestion!==null && set("playingHcp", phcpSuggestion)} style={{height:40,alignSelf:"end",padding:"0 12px",borderRadius:"var(--border-radius-md)",border:"1px solid var(--color-border-secondary)",background:"rgba(255,255,255,0.92)",cursor:phcpSuggestion!==null?"pointer":"not-allowed",color:"var(--color-text-primary)",fontSize:12,fontWeight:600,opacity:phcpSuggestion!==null?1:0.5}}>
          Auto
        </button>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))",gap:10,marginBottom:16}}>
        {r.mode==="Stableford"
          ? field(r.holes===9 ? "Stableford Punkte (9 Loch)" : "Stableford Punkte", <input type="number" style={inp} value={r.stablefordPoints||""} onChange={e=>set("stablefordPoints", parseInt(e.target.value))} placeholder={r.holes===9 ? "22" : "34"}/>)
          : field("AGS / Netto-Brutto", <input type="number" style={inp} value={r.adjustedGross||""} onChange={e=>set("adjustedGross", parseInt(e.target.value))} placeholder={r.holes===9 ? "48" : "95"}/>)}
        {field("Berechneter AGS", <input type="number" style={{...inp,background:"#f8f8f8"}} value={projectedGross ?? ""} readOnly/>, r.mode==="Stableford" ? "auto" : "manuell")}
      </div>
      {preview && (
        <div style={{...subtleCardStyle,padding:"14px 16px",marginBottom:16,border:"1px solid rgba(197,107,26,0.26)",background:"linear-gradient(180deg, #fff9f2 0%, #fff1df 100%)"}}>
          <div style={{fontSize:12,fontWeight:700,letterSpacing:"0.08em",textTransform:"uppercase",color:"#9a5314",marginBottom:8}}>Vorschau</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:10}}>
            <div><div style={{fontSize:12,color:"var(--color-text-secondary)"}}>Differential</div><div style={{fontSize:22,fontWeight:600}}>{preview.diff.toFixed(1)}</div></div>
            <div><div style={{fontSize:12,color:"var(--color-text-secondary)"}}>HCP danach</div><div style={{fontSize:22,fontWeight:600,color:COLORS.hcp}}>{preview.nextHcp.toFixed(1)}</div></div>
            <div><div style={{fontSize:12,color:"var(--color-text-secondary)"}}>Zaehlt?</div><div style={{fontSize:16,fontWeight:600,color:preview.wouldCount ? "#085041" : "#9a5314"}}>{preview.wouldCount ? "Ja" : "Eher nicht"}</div></div>
          </div>
          <div style={{marginTop:12,paddingTop:10,borderTop:"0.5px solid rgba(154,83,20,0.24)"}}>
            <div style={{fontSize:11,fontWeight:700,letterSpacing:"0.06em",textTransform:"uppercase",color:"#9a5314",marginBottom:6}}>So verändert sich die Wertung</div>
            {buildPreviewExplanation(preview).map((line,i)=>(
              <div key={i} style={{display:"flex",gap:8,alignItems:"flex-start",fontSize:12,color:"var(--color-text-secondary)",lineHeight:1.5,marginBottom:4}}>
                <span style={{color:"#9a5314",flexShrink:0}}>{i+1}.</span>
                <span>{line}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div style={{display:"flex",gap:8}}>
        <button onClick={handleSave} style={{padding:"9px 18px",borderRadius:"var(--border-radius-md)",background:COLORS.hcp,color:"#fff",border:"none",cursor:"pointer",fontWeight:500,fontSize:14}}>Simulationsrunde hinzufügen</button>
        <button onClick={onCancel} style={{padding:"9px 18px",borderRadius:"var(--border-radius-md)",background:"transparent",border:"0.5px solid var(--color-border-tertiary)",cursor:"pointer",fontSize:14,color:"var(--color-text-primary)"}}>Abbrechen</button>
      </div>
    </div>
  );
}

function HcpSimulator({courses, rounds, startHcp, simulatedRounds, onAddRound, onDeleteRound, onClearRounds}) {
  const [simForm, setSimForm] = useState(null);

  const actualTimeline = useMemo(()=>buildHandicapTimeline(rounds, startHcp), [rounds, startHcp]);
  const combinedRounds = useMemo(()=>[...rounds, ...simulatedRounds], [rounds, simulatedRounds]);
  const combinedTimeline = useMemo(()=>buildHandicapTimeline(combinedRounds, startHcp), [combinedRounds, startHcp]);
  const combinedSortedRounds = useMemo(()=>[...combinedRounds].sort((a,b)=>b.date.localeCompare(a.date) || (b.createdAt||"").localeCompare(a.createdAt||"") || (b.id||0)-(a.id||0)), [combinedRounds]);
  const combinedHcpRounds = useMemo(()=>combinedSortedRounds.filter(isHcpEligible), [combinedSortedRounds]);
  const recentTimeline = useMemo(()=>combinedTimeline.slice(-20), [combinedTimeline]);
  const recentDiffs = useMemo(()=>recentTimeline.map(entry=>entry.diff), [recentTimeline]);
  const scenarioHcp = useMemo(()=>combinedTimeline.length ? combinedTimeline[combinedTimeline.length-1].hcpAfter : (startHcp ?? 54), [combinedTimeline, startHcp]);
  const diffByRoundId = useMemo(()=>new Map(combinedTimeline.map(entry=>[entry.round.id, entry.diff])), [combinedTimeline]);
  const simulatedRoundIds = useMemo(()=>new Set(simulatedRounds.map(round=>round.id)), [simulatedRounds]);
  const projectedStartIndex = actualTimeline.length;

  const openDialog = () => {
    const nextDate = getNextDate(getLatestRoundDate(combinedRounds));
    setSimForm({
      id:null,
      date:nextDate,
      mode:"Stableford",
      format:"Einzel",
      holes:9,
      submitted:true,
      markerSigned:true,
      nineHoleAllowed:true,
      playingHcp:scenarioHcp,
      courseId:"",
      courseName:"",
      courseRating:"",
      slopeRating:"",
      par:32,
      stablefordPoints:"",
      adjustedGross:"",
      recentDiffs,
    });
  };

  const saveScenarioRound = round => {
    onAddRound({
      ...round,
      simulated:true,
      createdAt:new Date().toISOString(),
      submitted:true,
      markerSigned:true,
      format:"Einzel",
      nineHoleAllowed:parseInt(round.holes)===9 ? true : false,
    });
    setSimForm(null);
  };

  const scenarioDelta = round1(scenarioHcp - (actualTimeline.length ? actualTimeline[actualTimeline.length-1].hcpAfter : (startHcp ?? 54)));

  return (
    <div>
      <div style={{...cardStyle,padding:"20px 24px",marginBottom:20,position:"relative",overflow:"hidden",background:"linear-gradient(145deg, rgba(255,248,239,0.98) 0%, rgba(255,241,223,0.98) 100%)",border:"1px solid rgba(197,107,26,0.24)"}}>
        <div style={{position:"absolute",inset:0,background:"radial-gradient(circle at top right, rgba(197,107,26,0.12), transparent 30%)",pointerEvents:"none"}}/>
        <div style={{position:"relative",display:"flex",justifyContent:"space-between",gap:16,alignItems:"flex-start",flexWrap:"wrap"}}>
          <div>
            <div style={{fontSize:12,fontWeight:700,letterSpacing:"0.12em",textTransform:"uppercase",color:"#9a5314",marginBottom:6}}>Scenario Lab</div>
            <div style={{fontSize:24,fontWeight:600,color:"#2f2011",marginBottom:6}}>Mehrere Runden hintereinander simulieren</div>
            <div style={{fontSize:13,color:"#6f5841",maxWidth:520,lineHeight:1.6}}>
              Fuege einzelne Zukunftsrunden nacheinander hinzu. Die Statistiken, Tabellen und Charts laufen danach direkt weiter und zeigen die simulierten Runden in Orange.
            </div>
          </div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            <button onClick={openDialog} style={{padding:"9px 16px",borderRadius:"var(--border-radius-md)",background:"#C56B1A",color:"#fff",border:"none",cursor:"pointer",fontWeight:600,fontSize:14}}>+ Runde simulieren</button>
            <button onClick={onClearRounds} style={{padding:"9px 16px",borderRadius:"var(--border-radius-md)",background:"transparent",border:"1px solid rgba(197,107,26,0.28)",color:"#9a5314",cursor:simulatedRounds.length?"pointer":"not-allowed",opacity:simulatedRounds.length?1:0.5,fontSize:14}}>Szenario leeren</button>
          </div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:12,marginTop:18}}>
          <div style={{...subtleCardStyle,padding:"12px 14px",background:"rgba(255,255,255,0.72)"}}><div style={{fontSize:12,color:"var(--color-text-secondary)",marginBottom:4}}>Simulierte Runden</div><div style={{fontSize:24,fontWeight:600,color:"#2f2011"}}>{simulatedRounds.length}</div></div>
          <div style={{...subtleCardStyle,padding:"12px 14px",background:"rgba(255,255,255,0.72)"}}><div style={{fontSize:12,color:"var(--color-text-secondary)",marginBottom:4}}>HCP im Szenario</div><div style={{fontSize:24,fontWeight:600,color:COLORS.hcp}}>{scenarioHcp.toFixed(1)}</div></div>
          <div style={{...subtleCardStyle,padding:"12px 14px",background:"rgba(255,255,255,0.72)"}}><div style={{fontSize:12,color:"var(--color-text-secondary)",marginBottom:4}}>Aenderung</div><div style={{fontSize:24,fontWeight:600,color:scenarioDelta<0 ? COLORS.hcp : "#2f2011"}}>{`${scenarioDelta > 0 ? "+" : ""}${scenarioDelta.toFixed(1)}`}</div></div>
        </div>
      </div>

      <Dashboard
        rounds={combinedSortedRounds}
        hcpRounds={combinedHcpRounds}
        recentDiffs={recentDiffs}
        estimatedHcp={scenarioHcp}
        onNew={openDialog}
        hcpTimeline={combinedTimeline}
        diffByRoundId={diffByRoundId}
        projectedStartIndex={simulatedRounds.length ? projectedStartIndex : null}
        simulatedRoundIds={simulatedRoundIds}
        title="Szenario-Dashboard"
        recentTitle="Letzte echte und simulierte Runden"
        actionArea={simulatedRounds.length ? (
          <div style={{marginBottom:20}}>
            <div style={{fontSize:14,fontWeight:500,marginBottom:10}}>Simulierte Runden bearbeiten</div>
            {simulatedRounds.map(round=><RoundRow key={round.id} round={round} onDelete={()=>onDeleteRound(round.id)} diffByRoundId={diffByRoundId}/>)}
          </div>
        ) : null}
        emptyText="Lege die erste Simulationsrunde an, dann laeuft das Dashboard direkt in die Zukunft weiter."
      />

      {simForm && <Modal title="Simulationsrunde hinzufuegen" onClose={()=>setSimForm(null)}><SimulatorRoundForm initial={simForm} courses={courses} currentHcp={scenarioHcp} onSave={saveScenarioRound} onCancel={()=>setSimForm(null)}/></Modal>}
    </div>
  );
}

function Dashboard({rounds, hcpRounds, recentDiffs, estimatedHcp, onNew, hcpTimeline, diffByRoundId, projectedStartIndex=null, simulatedRoundIds=new Set(), title=null, recentTitle="Letzte Runden", actionArea=null, emptyText="Noch keine Runden erfasst", variant="full"}) {
  const [win, setWin] = useState({mode:"rounds", size:20});
  const [zoom, setZoom] = useState(null);
  const avgDiff = recentDiffs.length?(recentDiffs.reduce((s,d)=>s+d,0)/recentDiffs.length).toFixed(1):null;
  // Anzeigefenster: max. 20 Runden bzw. max. 365 Tage.
  const windowedTimeline = useMemo(()=>{
    const capped = hcpTimeline.slice(-20);
    if (win.mode==="rounds") return capped.slice(-Math.min(win.size,20));
    if (!capped.length) return capped;
    const latest = new Date(capped[capped.length-1].round.date).getTime();
    const cutoff = latest - Math.min(win.size,365)*86400000;
    return capped.filter(e=>new Date(e.round.date).getTime()>=cutoff);
  },[hcpTimeline, win]);
  const winProjectedStart = projectedStartIndex===null ? null : (()=>{
    const p = projectedStartIndex - (hcpTimeline.length - windowedTimeline.length);
    return p >= windowedTimeline.length ? null : Math.max(0, p);
  })();
  const chartData = useMemo(()=>windowedTimeline.map((entry,i)=>({x:i+1,diff:entry.diff,mode:entry.round.mode,date:entry.round.date})),[windowedTimeline]);
  const trendData = useMemo(()=>windowedTimeline.map((entry,i)=>({i:i+1,hcp:entry.hcpAfter,date:entry.round.date})),[windowedTimeline]);
  const summaryCards = [["Runden gesamt",rounds.length],["HCP-wirksam",hcpRounds.length],["Ø Differenzial",avgDiff??"–"],["Bestes Diff",recentDiffs.length?Math.min(...recentDiffs).toFixed(1):"–"]];
  if (simulatedRoundIds.size) summaryCards.push(["Simuliert", simulatedRoundIds.size]);

  // Wertungsfenster analysieren: die letzten 20 wertbaren Runden (nach Anzahl),
  // davon zählen die besten `take`.
  const windowEntries = hcpTimeline.slice(-20);
  const n = windowEntries.length;
  const windowFull = hcpTimeline.length >= 20;
  const take = n>0 ? getHandicapRule(n).take : 0;
  const newest = n ? windowEntries[n-1] : null;
  const oldest = n ? windowEntries[0] : null;
  const countingEntries = [...windowEntries].sort((a,b)=>a.diff-b.diff).slice(0,take);
  const countingIds = new Set(countingEntries.map(e=>e.round.id));
  const worstCounting = countingEntries.length ? countingEntries[countingEntries.length-1] : null;

  const focusItem = (label, entry, note, accent) => (
    <div style={{marginBottom:14}}>
      <div style={{fontSize:11,fontWeight:600,color:accent||"var(--color-text-secondary)",textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:6}}>{label}</div>
      {entry
        ? <RoundRow round={entry.round} compact counting={countingIds.has(entry.round.id)} diffByRoundId={diffByRoundId}/>
        : <div style={{fontSize:13,color:"var(--color-text-secondary)",padding:"4px 0"}}>–</div>}
      {note && <div style={{fontSize:12,color:"var(--color-text-secondary)",marginTop:4,lineHeight:1.5}}>{note}</div>}
    </div>
  );

  const emptyState = (
    <div style={{textAlign:"center",padding:"40px 0",color:"var(--color-text-secondary)"}}>
      <div style={{fontSize:32,marginBottom:12}}>⛳</div>
      <div style={{fontSize:15,marginBottom:16}}>{emptyText}</div>
      <button onClick={onNew} style={{padding:"10px 20px",borderRadius:"var(--border-radius-md)",background:COLORS.hcp,color:"#fff",border:"none",cursor:"pointer",fontWeight:500,fontSize:14}}>Erste Runde erfassen</button>
    </div>
  );

  const chartCard = (label, key, node) => (
    <div>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
        <div style={{fontSize:14,fontWeight:500}}>{label}</div>
        <button onClick={()=>setZoom(key)} title="Vergrößern" style={{fontSize:11,padding:"2px 8px",borderRadius:"var(--border-radius-md)",border:"0.5px solid var(--color-border-tertiary)",background:"transparent",cursor:"pointer",color:"var(--color-text-secondary)"}}>⤢ Zoom</button>
      </div>
      <div onClick={()=>setZoom(key)} style={{cursor:"zoom-in"}}>{node}</div>
    </div>
  );

  const graphs = (chartData.length>0 || trendData.length>=2) ? (
    <div style={{marginBottom:24}}>
      <ChartWindowControl win={win} setWin={setWin}/>
      <div style={{display:"grid",gridTemplateColumns:trendData.length>=2&&chartData.length>0?"1fr 1fr":"1fr",gap:16}}>
        {chartData.length>0 && chartCard("Score Differenzials","score",<ScoreChart data={chartData} projectedStartIndex={winProjectedStart}/>)}
        {trendData.length>=2 && chartCard("HCP-Entwicklung","trend",<HcpTrendChart trend={trendData} projectedStartIndex={winProjectedStart}/>)}
      </div>
    </div>
  ) : null;

  const focusSection = rounds.length===0 ? emptyState : n===0 ? (
    <div style={{fontSize:13,color:"var(--color-text-secondary)",padding:"8px 0"}}>Noch keine HCP-wirksame Runde. Sobald eine Runde wertbar ist, erscheint hier die Wertungsübersicht.</div>
  ) : (
    <div>
      <div style={{fontSize:12,color:"var(--color-text-secondary)",marginBottom:12,lineHeight:1.5}}>
        Deine HCP nutzt die besten {take} der letzten {n}{windowFull?"":" von 20"} wertbaren Runden. So verändert sie sich beim nächsten Ergebnis:
      </div>
      {focusItem("Letzte Runde", newest, newest?`Zuletzt gewertet am ${newest.round.date}.`:null, COLORS.hcp)}
      {worstCounting && focusItem(
        "Wird ersetzt, wenn besser",
        worstCounting,
        `Höchstes zählendes Differenzial (${worstCounting.diff.toFixed(1)}). Ein besseres Ergebnis verdrängt diese Runde aus den besten ${take}.`,
        COLORS.stroke,
      )}
      {focusItem(
        "Fällt als Nächstes aus dem Fenster",
        oldest,
        windowFull
          ? "Älteste der letzten 20 wertbaren Runden – sie fällt mit dem nächsten neuen Ergebnis aus dem Wertungsfenster."
          : `Aktuell fällt noch keine Runde heraus: erst ab 20 Runden im Fenster (derzeit ${n}). Dann würde diese älteste (${oldest?.round.date}) als Erste herausfallen.`,
        "#8a6d1f",
      )}
    </div>
  );

  return (
    <div>
      {title && <div style={{fontSize:18,fontWeight:600,marginBottom:14,color:"var(--color-text-primary)"}}>{title}</div>}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))",gap:12,marginBottom:24}}>
        {summaryCards.map(([label,val])=>(
          <div key={label} style={{...subtleCardStyle,padding:"14px 16px",position:"relative",overflow:"hidden"}}>
            <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:label==="Bestes Diff"?COLORS.stroke:label==="Ø Differenzial"?COLORS.stableford:label==="Simuliert"?"#C56B1A":COLORS.hcp,opacity:0.8}}/>
            <div style={{fontSize:12,color:"var(--color-text-secondary)",marginBottom:4}}>{label}</div>
            <div style={{fontSize:22,fontWeight:500,color:"var(--color-text-primary)"}}>{val}</div>
          </div>
        ))}
      </div>

      {actionArea}

      {variant==="focus" ? (
        <>
          <div style={{fontSize:14,fontWeight:500,marginBottom:10}}>Wertungsfenster</div>
          <div style={{...subtleCardStyle,padding:"16px 18px",marginBottom:24}}>{focusSection}</div>
          {graphs}
        </>
      ) : (
        <>
          {hcpRounds.length>0 && <HcpRoundsTable rounds={hcpRounds} diffByRoundId={diffByRoundId} simulatedRoundIds={simulatedRoundIds}/>}
          {graphs}
          {rounds.length===0 ? emptyState : (
            <div>
              <div style={{display:"flex",alignItems:"baseline",justifyContent:"space-between",gap:8,marginBottom:10}}>
                <div style={{fontSize:14,fontWeight:500}}>{recentTitle}</div>
                {rounds.length>3 && <div style={{fontSize:12,color:"var(--color-text-secondary)"}}>letzte 3 · alle unter „Runden“</div>}
              </div>
              {rounds.slice(0,3).map(r=><RoundRow key={r.id} round={r} compact diffByRoundId={diffByRoundId}/>)}
            </div>
          )}
        </>
      )}

      {zoom && (
        <Modal title={zoom==="score"?"Score Differenzials":"HCP-Entwicklung"} onClose={()=>setZoom(null)} maxWidth={960}>
          <ChartWindowControl win={win} setWin={setWin}/>
          {zoom==="score"
            ? <ScoreChart data={chartData} projectedStartIndex={winProjectedStart} width={900} height={440} interactive/>
            : <HcpTrendChart trend={trendData} projectedStartIndex={winProjectedStart} width={900} height={440} interactive/>}
          <div style={{fontSize:12,color:"var(--color-text-secondary)",marginTop:10}}>Punkte antippen oder überfahren für Datum und Wert.</div>
        </Modal>
      )}
    </div>
  );
}

function DataPortability({db, onJsonImport, onGolfDePdfImport}) {
  const [jsonStatus, setJsonStatus] = useState({ tone:"", message:"" });
  const [pdfStatus, setPdfStatus] = useState({ tone:"", message:"" });
  const [pdfImportMode, setPdfImportMode] = useState("merge");
  const importCard = (title, description, actionLabel, accept, onChange, status, tone="neutral", extraContent=null) => {
    const background = tone === "pdf"
      ? "linear-gradient(180deg, rgba(225,241,251,0.96) 0%, rgba(244,249,253,0.96) 100%)"
      : "linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(246,248,245,0.95) 100%)";
    const borderColor = tone === "pdf" ? "rgba(12,68,124,0.18)" : "var(--color-border-tertiary)";

    return (
      <div style={{...subtleCardStyle,background,border:`1px solid ${borderColor}`,padding:"18px 20px"}}>
        <div style={{fontSize:14,fontWeight:600,marginBottom:6}}>{title}</div>
        <div style={{fontSize:13,color:"var(--color-text-secondary)",marginBottom:14,lineHeight:1.55}}>{description}</div>
        {extraContent}
        <label style={{display:"inline-block",padding:"9px 18px",borderRadius:"var(--border-radius-md)",background:tone==="pdf"?"#0C447C":"#F5F4F0",border:tone==="pdf"?"1px solid #0C447C":"0.5px solid var(--color-border-secondary)",cursor:"pointer",fontWeight:600,fontSize:14,color:tone==="pdf"?"#fff":"#111"}}>
          {actionLabel}
          <input type="file" accept={accept} onChange={onChange} style={{display:"none"}}/>
        </label>
        {status.message && <div style={{marginTop:10,fontSize:13,color:status.tone==="success"?"#1D9E75":"#E24B4A",fontWeight:status.tone==="success"?500:400}}>{status.message}</div>}
      </div>
    );
  };

  const handleExport = () => {
    const json = JSON.stringify(db, null, 2);
    const blob = new Blob([json], {type:"application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `wolf-golf-export-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleJsonImport = async (e) => {
    setJsonStatus({ tone:"", message:"" });
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data.rounds || !data.courses || !data.profile) throw new Error("Ungueltiges Format");
      onJsonImport(data);
      setJsonStatus({ tone:"success", message:"Backup erfolgreich wiederhergestellt." });
    } catch (err) {
      setJsonStatus({ tone:"error", message:"Datei konnte nicht gelesen werden. Bitte eine gueltige Export-Datei verwenden." });
    }
    e.target.value = "";
  };

  const handleGolfDeImport = async (e) => {
    setPdfStatus({ tone:"", message:"" });
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const pdfText = await extractGolfDePdfText(file);
      const parsedRounds = parseGolfDeDetailedReport(pdfText);
      const result = onGolfDePdfImport(parsedRounds, pdfImportMode);
      const parts = [`${result.importedRounds} Runde${result.importedRounds===1?"":"n"} importiert`];
      if (pdfImportMode === "replace") parts.push("bestehende Daten ersetzt");
      if (result.createdCourses) parts.push(`${result.createdCourses} Platz/Plätze angelegt`);
      if (result.skippedRounds) parts.push(`${result.skippedRounds} Duplikat${result.skippedRounds===1?"":"e"} uebersprungen`);
      setPdfStatus({ tone:"success", message:parts.join(" · ") });
    } catch (err) {
      const message = err instanceof Error ? err.message : "PDF konnte nicht gelesen werden.";
      setPdfStatus({ tone:"error", message });
    }

    e.target.value = "";
  };

  const btn = (onClick, label, danger=false) => (
    <button onClick={onClick} style={{padding:"9px 18px",borderRadius:"var(--border-radius-md)",background:danger?"#E24B4A":COLORS.hcp,color:"#fff",border:"none",cursor:"pointer",fontWeight:500,fontSize:14}}>
      {label}
    </button>
  );

  return (
    <div style={{...cardStyle,padding:"20px 24px"}}>
      <div style={{marginBottom:24}}>
        <div style={{fontSize:14,fontWeight:500,marginBottom:6}}>Export</div>
        <div style={{fontSize:13,color:"var(--color-text-secondary)",marginBottom:12}}>
          Alle Runden, Plätze und Profildaten als JSON-Datei herunterladen.
        </div>
        {btn(handleExport, `Exportieren (${db.rounds.length} Runden, ${db.courses.length} Plätze)`)}
      </div>

      <div style={{borderTop:"0.5px solid var(--color-border-tertiary)",paddingTop:20}}>
        <div style={{fontSize:14,fontWeight:600,marginBottom:12}}>Importe</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(260px, 1fr))",gap:14}}>
          {importCard(
            "Backup per JSON",
            <>Daten aus einer Export-Datei wiederherstellen. <strong>Bestehende Daten werden überschrieben.</strong></>,
            "JSON-Datei wählen",
            ".json,application/json",
            handleJsonImport,
            jsonStatus,
          )}
          {importCard(
            "golf.de PDF Import",
            <>Liest Runden aus dem golf.de Scoring Record und legt fehlende Plaetze automatisch an. Bitte immer den <strong>detaillierten Report</strong> als PDF drucken, damit CR, Slope, Abschlag und CH enthalten sind.</>,
            "PDF wählen",
            ".pdf,application/pdf",
            handleGolfDeImport,
            pdfStatus,
            "pdf",
            <div style={{display:"inline-flex",alignItems:"center",gap:4,marginBottom:12,padding:"4px",borderRadius:999,background:"rgba(12,68,124,0.08)",border:"1px solid rgba(12,68,124,0.12)"}}>
              <button
                type="button"
                onClick={()=>setPdfImportMode("merge")}
                style={{padding:"5px 10px",borderRadius:999,border:"none",cursor:"pointer",fontSize:12,fontWeight:600,background:pdfImportMode==="merge"?"#0C447C":"transparent",color:pdfImportMode==="merge"?"#fff":"#0C447C"}}
              >
                Zusammenführen
              </button>
              <button
                type="button"
                onClick={()=>setPdfImportMode("replace")}
                style={{padding:"5px 10px",borderRadius:999,border:"none",cursor:"pointer",fontSize:12,fontWeight:600,background:pdfImportMode==="replace"?"#0C447C":"transparent",color:pdfImportMode==="replace"?"#fff":"#0C447C"}}
              >
                Ersetzen
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function HcpInfo() {
  const card = (children) => (
    <div style={{...cardStyle,padding:"16px 20px",marginBottom:14}}>
      {children}
    </div>
  );
  const h = (text) => <div style={{fontSize:14,fontWeight:500,marginBottom:8,color:"#111"}}>{text}</div>;
  const formula = (text) => (
    <div style={{background:"#F5F4F0",borderRadius:"var(--border-radius-md)",padding:"10px 14px",fontFamily:"monospace",fontSize:13,margin:"8px 0",color:"#111"}}>
      {text}
    </div>
  );
  const p = (text) => <div style={{fontSize:13,color:"var(--color-text-secondary)",marginBottom:6,lineHeight:1.6}}>{text}</div>;

  return (
    <div>
      {card(<>
        {h("Was ist der Handicap Index?")}
        {p("Der Handicap Index (HCP) ist eine Kennzahl, die dein spielerisches Potential widerspiegelt – unabhängig vom Platz. Grundlage ist das World Handicap System (WHS), das seit 2020 weltweit gilt und in Deutschland vom DGV angewendet wird.")}
        {p("Ein niedriger HCP bedeutet besseres Spiel. Anfänger starten bei max. 54.")}
      </>)}

      {card(<>
        {h("Schritt 1 – Score Differenzial berechnen")}
        {p("Nach jeder HCP-wirksamen Runde wird ein Score Differenzial ermittelt. Es normiert dein Ergebnis auf einen Standardplatz (Slope 113).")}
        {formula("Differenzial = (GBE − Course Rating) × 113 ÷ Slope Rating")}
        {p("GBE = Gross Brutto Ergebnis (angepasstes Brutto-Score). Course Rating und Slope Rating stehen auf der Scorekarte des Platzes.")}
        {p("Beispiel: GBE 95, CR 72.0, SR 130 → (95 − 72) × 113 ÷ 130 = 20.0")}
        {p("Im vollständigen WHS wird zusätzlich die Platzverhältnis-Korrektur PCC abgezogen: Differenzial = (GBE − Course Rating − PCC) × 113 ÷ Slope Rating. Die App berechnet das Differenzial selbst aus GBE, Course Rating und Slope und rechnet dabei mit PCC = 0 (Details siehe „Weitere WHS-Anpassungen“).")}
        {formula("9-Loch: tatsächliches 9-Loch-Differenzial\n= (GBE − Course Rating) × 113 ÷ Slope Rating\n\n18-Loch-Wert = 9-Loch-Differenzial + erwartetes 9-Loch-Differenzial\naus dem aktuellen Handicap Index")}
      </>)}

      {card(<>
        {h("Schritt 2 – Beste Differenziale auswählen")}
        {p("Es zählen die letzten 20 HCP-wirksamen Runden. Je nach Gesamtanzahl werden die besten N Differenziale gewählt:")}
        <div style={{border:"0.5px solid var(--color-border-tertiary)",borderRadius:"var(--border-radius-md)",overflow:"hidden",marginTop:8}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",background:"var(--color-background-secondary)",padding:"6px 12px",fontSize:11,fontWeight:500,color:"var(--color-text-secondary)"}}>
            <span>Runden</span><span style={{textAlign:"center"}}>Beste</span><span style={{textAlign:"right"}}>Anpassung</span>
          </div>
          {HCP_RULES.map((rule,i)=>(
            <div key={i} style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",padding:"5px 12px",fontSize:12,borderTop:"0.5px solid var(--color-border-tertiary)",background:i%2===0?"#fff":"var(--color-background-secondary)"}}>
              <span>{(() => {
                const from = i===0 ? 1 : HCP_RULES[i-1].maxRounds+1;
                return from===rule.maxRounds ? `${from}` : `${from}–${rule.maxRounds}`;
              })()}</span>
              <span style={{textAlign:"center"}}>{rule.take}</span>
              <span style={{textAlign:"right",color:rule.adj<0?"#E24B4A":rule.adj>0?"#888":"inherit"}}>
                {rule.adj<0 ? rule.adj : rule.adj>0 ? `+${rule.adj}` : "–"}
              </span>
            </div>
          ))}
        </div>
      </>)}

      {card(<>
        {h("Schritt 3 – Handicap Index berechnen")}
        {p("Der Handicap Index ergibt sich aus dem Mittelwert der aktuell zählenden Differenziale plus der WHS-Anpassung für kleine Rundenzahlen. Das Ergebnis wird auf 1 Dezimalstelle gerundet und auf max. 54 begrenzt.")}
        {formula("HCP Index = Ø(beste Differenziale) + Anpassung")}
        {p("Dies ist der WHS-Grundwert. Er entspricht dem, was golf.de als „Berechneter HCPI“ ausweist. Der offiziell geführte HCPI kann davon abweichen, sobald Bremse/Cap oder ein Exceptional Score greifen (siehe unten).")}
      </>)}

      {card(<>
        {h("Weitere WHS-Anpassungen")}
        {p("Das World Handicap System kennt Korrekturen über den reinen Mittelwert hinaus. Die App verarbeitet die Runden chronologisch und bildet dabei Exceptional Score und die DGV-Anfängerregel (Bremse) mit ab. PCC wird als 0 angenommen (bei golf.de-Import steckt eine Platzverhältnis-Korrektur bereits im Bruttoergebnis).")}
        {p("• PCC (Playing Conditions Calculation): tagesbezogene Platzverhältnis-Korrektur des Differenzials.")}
        {p("• Exceptional Score (Regel 5.9): liegt ein Differenzial 7,0–9,9 Schläge unter dem Index, werden alle aktuellen Differenziale um 1,0 gesenkt, bei 10,0 oder mehr um 2,0. Entscheidend ist der Zeitpunkt: Die Reduktion greift ab der Ausnahmerunde und wirkt auf die dann vorhandenen Differenziale – deshalb ist die chronologische Reihenfolge (auch beim Import) wichtig.")}
        {p("• Bremse (DGV-Anfängerregel): Solange dein Handicap-Index über 26,9 liegt, kann er nur besser werden – ein einmal erspielter Index wird nicht wieder angehoben. Ab 26,9 bewegt er sich normal in beide Richtungen. Deshalb bleibt z. B. ein nach einer starken Runde erspielter Index bestehen, auch wenn danach schwächere Runden folgen.")}
      </>)}

      {card(<>
        {h("Wann ist eine Runde HCP-wirksam?")}
        {[
          "Eingereicht (submitted)",
          "Marker unterschrieben",
          "Einzel-Format (kein Vierer/Vierball)",
          "Spielmodus: Stableford oder Stroke Play",
          "18 Loch – oder 9 Loch mit aktivierter 9-Loch-Wertung",
        ].map((item,i)=>(
          <div key={i} style={{display:"flex",gap:8,alignItems:"flex-start",fontSize:13,color:"var(--color-text-secondary)",marginBottom:4}}>
            <span style={{color:"#1D9E75",fontWeight:500,flexShrink:0}}>✓</span>
            <span>{item}</span>
          </div>
        ))}
      </>)}

      {card(<>
        {h("Feedback und Bugs")}
        {p("Wenn dir ein Fehler auffaellt oder ein Import nicht sauber funktioniert, melde ihn bitte direkt im GitHub-Repository.")}
        <a
          href={GITHUB_ISSUES_URL}
          target="_blank"
          rel="noreferrer"
          style={{display:"inline-flex",alignItems:"center",gap:8,padding:"10px 14px",borderRadius:"var(--border-radius-md)",background:"#E1F1FB",color:"#0C447C",textDecoration:"none",fontSize:13,fontWeight:600,border:"1px solid rgba(12,68,124,0.18)"}}
        >
          Bugs auf GitHub melden
        </a>
      </>)}

      {card(<>
        {h("Datenschutz")}
        {p("Die App speichert Runden, Plaetze und Profildaten lokal im Browser auf deinem Geraet. Es gibt keinen Login, keine Server-Synchronisation und kein eingebautes Tracking oder Analytics.")}
        {p("Der aktuelle Stand ist als private, nicht-kommerzielle App gedacht und wird nicht ueber eine eigene oeffentlich auffindbare Domain vermarktet. Wenn sich Hosting, Tracking oder Datenfluesse spaeter aendern, muss der Datenschutzhinweis entsprechend angepasst werden.")}
      </>)}
    </div>
  );
}

function AppFooter() {
  const year = new Date().getFullYear();
  const linkStyle: CSSProperties = {
    color: "#0C447C",
    textDecoration: "none",
    fontWeight: 600,
  };

  return (
    <footer style={{...cardStyle,padding:"18px 20px",marginTop:24,background:"linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(241,245,242,0.95) 100%)"}}>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(200px, 1fr))",gap:18}}>
        <div>
          <div style={{fontSize:12,fontWeight:700,letterSpacing:"0.12em",textTransform:"uppercase",color:"#1D9E75",marginBottom:8}}>Wolf Golf</div>
          <div style={{fontSize:13,color:"var(--color-text-secondary)",lineHeight:1.6}}>
            Lokaler Golf-Handicap-Tracker fuer Runden, Simulator und golf.de PDF-Import direkt im Browser.
          </div>
        </div>
        <div>
          <div style={{fontSize:12,fontWeight:700,letterSpacing:"0.12em",textTransform:"uppercase",color:"#1D9E75",marginBottom:8}}>Support</div>
          <div style={{fontSize:13,lineHeight:1.8}}>
            <a href={GITHUB_ISSUES_URL} target="_blank" rel="noreferrer" style={linkStyle}>Bug auf GitHub melden</a>
          </div>
          <div style={{fontSize:13,lineHeight:1.8}}>
            <a href={GITHUB_REPO_URL} target="_blank" rel="noreferrer" style={linkStyle}>Repository ansehen</a>
          </div>
        </div>
        <div>
          <div style={{fontSize:12,fontWeight:700,letterSpacing:"0.12em",textTransform:"uppercase",color:"#1D9E75",marginBottom:8}}>Rechtliches</div>
          <div style={{fontSize:13,color:"var(--color-text-secondary)",lineHeight:1.6}}>
            Diese App ist derzeit als private, nicht-kommerzielle Anwendung gedacht, ohne eigene oeffentlich vermarktete Domain. Daten bleiben lokal im Browser; es gibt keinen Login und kein eingebautes Tracking. Wenn die App spaeter oeffentlich betrieben wird, muessen Impressum und Datenschutzhinweise erneut geprueft und ergaenzt werden.
          </div>
        </div>
      </div>
      <div style={{marginTop:16,paddingTop:14,borderTop:"1px solid var(--color-border-tertiary)",display:"flex",justifyContent:"space-between",gap:12,flexWrap:"wrap",fontSize:12,color:"var(--color-text-secondary)"}}>
        <span>{year} Wolf Golf</span>
        <span>Feedback und Fehlermeldungen laufen ueber GitHub Issues.</span>
      </div>
    </footer>
  );
}

function LandingPage({profile, onSave}) {
  const featureCardStyle: CSSProperties = {
    ...subtleCardStyle,
    padding: "18px 18px 20px",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  };
  const stepStyle: CSSProperties = {
    ...cardStyle,
    padding: "18px 20px",
    display: "flex",
    gap: 14,
    alignItems: "flex-start",
  };
  const sectionTitleStyle: CSSProperties = {
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    color: "rgba(255,255,255,0.72)",
    marginBottom: 10,
  };

  return (
    <div style={{maxWidth:980,margin:"0 auto",padding:appShellPadding,fontFamily:"var(--font-sans)",color:"var(--color-text-primary)",boxSizing:"border-box",width:"100%"}}>
      <div style={{...cardStyle,padding:"28px 28px 30px",marginBottom:18,background:"linear-gradient(145deg, rgba(20,46,37,0.98) 0%, rgba(18,57,44,0.95) 44%, rgba(29,158,117,0.82) 100%)",color:"#fff",position:"relative",overflow:"hidden"}}>
        <div style={{position:"absolute",inset:0,background:"radial-gradient(circle at 82% 18%, rgba(255,255,255,0.2), transparent 24%), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)",backgroundSize:"auto, 28px 28px",opacity:0.35,pointerEvents:"none"}}/>
        <div style={{position:"relative",display:"flex",flexWrap:"wrap",gap:24,alignItems:"start"}}>
          <div style={{flex:"1 1 420px",minWidth:0}}>
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:18}}>
              <BrandMark size={46}/>
              <div style={{fontSize:24,fontWeight:700,letterSpacing:"-0.01em"}}>Wolf Golf</div>
            </div>
            <div style={sectionTitleStyle}>Golf Handicap Im Browser</div>
            <div style={{fontSize:40,lineHeight:1.05,fontWeight:700,maxWidth:560,marginBottom:12}}>Der einfache Tracker fuer HCP, Runden und Verlauf.</div>
            <div style={{fontSize:16,lineHeight:1.6,color:"rgba(255,255,255,0.78)",maxWidth:560,marginBottom:18}}>
              Runden rein, Handicap raus. Klar, lokal und direkt im Browser.
            </div>
            <div style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:22}}>
              {badge("DGV · WHS", "rgba(255,255,255,0.14)", "#fff")}
              {badge("lokal im Browser", "rgba(255,255,255,0.14)", "#fff")}
              {badge("Simulator inklusive", "rgba(255,255,255,0.14)", "#fff")}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(180px, 1fr))",gap:12}}>
              <div style={{padding:"14px 16px",borderRadius:"var(--border-radius-md)",background:"rgba(255,255,255,0.12)",border:"1px solid rgba(255,255,255,0.12)"}}>
                <div style={{fontSize:12,fontWeight:700,letterSpacing:"0.08em",textTransform:"uppercase",color:"rgba(255,255,255,0.68)",marginBottom:6}}>Tracken</div>
                <div style={{fontSize:14,lineHeight:1.5,color:"rgba(255,255,255,0.84)"}}>Runden, Plaetze und Playing HCP an einem Ort.</div>
              </div>
              <div style={{padding:"14px 16px",borderRadius:"var(--border-radius-md)",background:"rgba(255,255,255,0.12)",border:"1px solid rgba(255,255,255,0.12)"}}>
                <div style={{fontSize:12,fontWeight:700,letterSpacing:"0.08em",textTransform:"uppercase",color:"rgba(255,255,255,0.68)",marginBottom:6}}>Berechnen</div>
                <div style={{fontSize:14,lineHeight:1.5,color:"rgba(255,255,255,0.84)"}}>Differenziale, Trend und aktueller Index automatisch.</div>
              </div>
              <div style={{padding:"14px 16px",borderRadius:"var(--border-radius-md)",background:"rgba(255,255,255,0.12)",border:"1px solid rgba(255,255,255,0.12)"}}>
                <div style={{fontSize:12,fontWeight:700,letterSpacing:"0.08em",textTransform:"uppercase",color:"rgba(255,255,255,0.68)",marginBottom:6}}>Lokal</div>
                <div style={{fontSize:14,lineHeight:1.5,color:"rgba(255,255,255,0.84)"}}>Nach dem ersten Laden hilft der Browser-Cache fuer schnellen Zugriff.</div>
              </div>
            </div>
          </div>

          <div style={{...cardStyle,flex:"1 1 320px",minWidth:"min(100%, 320px)",padding:"20px 20px 24px",background:"linear-gradient(180deg, rgba(255,255,255,0.97) 0%, rgba(244,248,245,0.94) 100%)",color:"var(--color-text-primary)"}}>
            <div style={{fontSize:12,fontWeight:700,letterSpacing:"0.14em",textTransform:"uppercase",color:"#1D9E75",marginBottom:8}}>Direkter Einstieg</div>
            <div style={{fontSize:24,fontWeight:650,marginBottom:6}}>Kurz einrichten</div>
            <div style={{fontSize:14,lineHeight:1.6,color:"var(--color-text-secondary)",marginBottom:18}}>Name und Start-HCP eintragen, dann geht es direkt los.</div>
            <ProfileForm profile={profile} onSave={onSave} isSetup/>
          </div>
        </div>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(220px, 1fr))",gap:14,marginBottom:18}}>
        <div style={featureCardStyle}>
          <div style={{fontSize:13,fontWeight:700,color:"#1D9E75",letterSpacing:"0.04em",textTransform:"uppercase"}}>Runden</div>
          <div style={{fontSize:20,fontWeight:650}}>Alles sauber erfasst</div>
          <div style={{fontSize:14,lineHeight:1.6,color:"var(--color-text-secondary)"}}>9 oder 18 Loch, Stableford oder Stroke Play.</div>
        </div>
        <div style={featureCardStyle}>
          <div style={{fontSize:13,fontWeight:700,color:"#1D9E75",letterSpacing:"0.04em",textTransform:"uppercase"}}>HCP</div>
          <div style={{fontSize:20,fontWeight:650}}>Nachvollziehbar berechnet</div>
          <div style={{fontSize:14,lineHeight:1.6,color:"var(--color-text-secondary)"}}>Du siehst direkt, was zaehlt und wie dein Index entsteht.</div>
        </div>
        <div style={featureCardStyle}>
          <div style={{fontSize:13,fontWeight:700,color:"#1D9E75",letterSpacing:"0.04em",textTransform:"uppercase"}}>Simulator</div>
          <div style={{fontSize:20,fontWeight:650}}>Vorher durchspielen</div>
          <div style={{fontSize:14,lineHeight:1.6,color:"var(--color-text-secondary)"}}>Teste kuenftige Runden und ihren Einfluss auf dein HCP.</div>
        </div>
      </div>

      <div style={{display:"grid",gap:12,marginBottom:18}}>
        <div style={stepStyle}>
          <div style={{width:32,height:32,borderRadius:999,background:"rgba(29,158,117,0.12)",color:"#1D9E75",display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,fontWeight:700,flexShrink:0}}>1</div>
          <div>
            <div style={{fontSize:17,fontWeight:600,marginBottom:4}}>Profil und Plaetze anlegen</div>
            <div style={{fontSize:14,lineHeight:1.6,color:"var(--color-text-secondary)"}}>Start-HCP eintragen, Platzdaten hinterlegen.</div>
          </div>
        </div>
        <div style={stepStyle}>
          <div style={{width:32,height:32,borderRadius:999,background:"rgba(29,158,117,0.12)",color:"#1D9E75",display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,fontWeight:700,flexShrink:0}}>2</div>
          <div>
            <div style={{fontSize:17,fontWeight:600,marginBottom:4}}>Runden speichern</div>
            <div style={{fontSize:14,lineHeight:1.6,color:"var(--color-text-secondary)"}}>Differenziale, Trend und Dashboard aktualisieren sich automatisch.</div>
          </div>
        </div>
        <div style={stepStyle}>
          <div style={{width:32,height:32,borderRadius:999,background:"rgba(29,158,117,0.12)",color:"#1D9E75",display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,fontWeight:700,flexShrink:0}}>3</div>
          <div>
            <div style={{fontSize:17,fontWeight:600,marginBottom:4}}>Schnell wieder da</div>
            <div style={{fontSize:14,lineHeight:1.6,color:"var(--color-text-secondary)"}}>Der Browser-Cache haelt die App nach dem ersten Laden griffbereit.</div>
          </div>
        </div>
      </div>

      <AppFooter/>
    </div>
  );
}

const SIDEBAR_WIDTH = 248;
const SIDEBAR_WIDTH_COLLAPSED = 76;
const NAV_COLLAPSED_KEY = "golf_hcp_nav_collapsed";
const DESKTOP_QUERY = "(min-width: 1024px)";
const NAV_ITEMS = [
  { id:"dashboard", label:"Dashboard", icon:["M4 13h6V4H4v9Z","M14 20h6v-9h-6v9Z","M4 20h6v-4H4v4Z","M14 8h6V4h-6v4Z"] },
  { id:"simulator", label:"Simulator", icon:["M4 17l5-5 3 3 7-7","M15 8h5v5"] },
  { id:"rounds", label:"Runden", icon:["M8 6h12","M8 12h12","M8 18h12","M4 6h.01","M4 12h.01","M4 18h.01"] },
  { id:"courses", label:"Plätze", icon:["M7 20V4","M7 5.2l9 2.6-9 2.6","M4.5 20h6"] },
  { id:"profile", label:"Profil", icon:["M12 11a4 4 0 100-8 4 4 0 000 8Z","M4.5 21a7.5 7.5 0 0115 0"] },
  { id:"data", label:"Daten", icon:["M12 3v11","M8.5 10.5L12 14l3.5-3.5","M4 20h16"] },
  { id:"info", label:"HCP-Info", icon:["M12 21a9 9 0 100-18 9 9 0 000 18Z","M12 11v6","M12 8h.01"] },
];

function useMediaQuery(query) {
  const [matches, setMatches] = useState(()=>{
    if (typeof window==="undefined" || typeof window.matchMedia!=="function") return false;
    return window.matchMedia(query).matches;
  });

  useEffect(()=>{
    if (typeof window==="undefined" || typeof window.matchMedia!=="function") return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return ()=>media.removeEventListener("change", update);
  },[query]);

  return matches;
}

function loadNavCollapsed() {
  try { return localStorage.getItem(NAV_COLLAPSED_KEY)==="1"; } catch(e) { return false; }
}
function saveNavCollapsed(collapsed) { try { localStorage.setItem(NAV_COLLAPSED_KEY, collapsed?"1":"0"); } catch(e) {} }

function NavIcon({paths, size=20}) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{flexShrink:0,display:"block"}}>
      {paths.map((d,i)=><path key={i} d={d}/>)}
    </svg>
  );
}

// Bildmarke "Wolf Golf": Golffahne mit Wolfskopf im Profil.
// Die Geometrie ist identisch zu scripts/generate-icons.py (Quelle der Icons in public/).
const WOLF_FLAG_PATH = "M 17.5 8.5 C 30 6.5 39.5 10 50.5 9.5 L 44.5 21.5 L 50.5 33.5 C 39.5 33 30 36.5 17.5 34.5 Z";
const WOLF_HEAD_PATH = "M 2 37 L 30 33 L 36 27 L 46 24 L 58 0 L 69 23 L 80 32 L 91 45 L 75 50 L 84 60 L 66 62 L 69 71 L 50 66 L 41 62 L 28 51 L 12 47 L 5 45.5 L 0 41 Z";
const WOLF_EYE_PATH = "M 33 30.5 L 41.5 33 L 38 37 L 32 34.5 Z";
const WOLF_EAR_PATH = "M 53 9 L 63 21 L 55 21 Z";
const WOLF_DARK = "#0E4C3A";

function WolfFlagMark({size=34}) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" style={{flexShrink:0,display:"block"}}>
      <g transform="translate(-11.26 -0.71) scale(1.34)">
        <line x1="15.5" y1="8.5" x2="15.5" y2="42.3" stroke="#fff" strokeWidth={3} strokeLinecap="round"/>
        <path d={WOLF_FLAG_PATH} fill="#fff"/>
        <g transform="translate(19.898 12.748) scale(0.255)">
          <path d={WOLF_HEAD_PATH} fill={WOLF_DARK}/>
          <path d={WOLF_EYE_PATH} fill="#fff"/>
          <path d={WOLF_EAR_PATH} fill="#fff"/>
        </g>
      </g>
    </svg>
  );
}

function BrandMark({size=34}) {
  return (
    <div style={{width:size,height:size,borderRadius:Math.round(size*0.35),flexShrink:0,display:"grid",placeItems:"center",background:"linear-gradient(135deg, #25AF83 0%, #1D9E75 50%, #0F5C46 100%)",boxShadow:"0 8px 18px rgba(6,26,19,0.42)"}}>
      <WolfFlagMark size={size}/>
    </div>
  );
}

function SideNav({view, onSelect, isDesktop, collapsed, onToggleCollapsed, open, onClose, profileName, displayHcp}) {
  const [hovered, setHovered] = useState(null);
  const showLabels = !isDesktop || !collapsed;
  const panelWidth = isDesktop ? (collapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH) : "min(86vw, 268px)";
  const iconButton: CSSProperties = { display:"grid",placeItems:"center",width:34,height:34,flexShrink:0,padding:0,borderRadius:11,border:"1px solid rgba(255,255,255,0.16)",background:"rgba(255,255,255,0.08)",color:"#fff",cursor:"pointer" };

  const panel = (
    <nav aria-label="Hauptnavigation" style={{
      width:panelWidth,height:"100%",boxSizing:"border-box",display:"flex",flexDirection:"column",
      background:"linear-gradient(168deg, rgba(17,42,33,0.98) 0%, rgba(18,57,44,0.97) 44%, rgba(24,110,84,0.94) 100%)",
      color:"#fff",
      paddingTop:"calc(env(safe-area-inset-top) + 16px)",
      paddingBottom:"calc(env(safe-area-inset-bottom) + 18px)",
      paddingRight:showLabels?14:12,
      paddingLeft:isDesktop?(showLabels?14:12):"max(14px, env(safe-area-inset-left))",
      borderRight:"1px solid rgba(255,255,255,0.08)",
      transition:"width 220ms ease",
      overflowY:"auto",
    }}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16,justifyContent:showLabels?"space-between":"center"}}>
        {showLabels ? (
          <>
            <div style={{display:"flex",alignItems:"center",gap:10,minWidth:0}}>
              <BrandMark/>
              <div style={{minWidth:0}}>
                <div style={{fontSize:14,fontWeight:600,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>Wolf Golf</div>
                <div style={{fontSize:11,color:"rgba(255,255,255,0.6)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{profileName||"DGV · WHS"}</div>
              </div>
            </div>
            <button onClick={isDesktop?onToggleCollapsed:onClose} title={isDesktop?"Navigation einklappen":"Navigation schliessen"} aria-label={isDesktop?"Navigation einklappen":"Navigation schliessen"} style={iconButton}>
              <NavIcon paths={isDesktop?["M14 7l-5 5 5 5","M19 7l-5 5 5 5"]:["M7 7l10 10","M17 7L7 17"]} size={17}/>
            </button>
          </>
        ) : <BrandMark/>}
      </div>

      {isDesktop && collapsed && (
        <button onClick={onToggleCollapsed} title="Navigation ausklappen" aria-label="Navigation ausklappen" style={{...iconButton,width:"100%",height:32,marginBottom:14}}>
          <NavIcon paths={["M10 7l5 5-5 5","M5 7l5 5-5 5"]} size={17}/>
        </button>
      )}

      <div style={{display:"flex",flexDirection:"column",gap:4}}>
        {NAV_ITEMS.map(item=>{
          const active = view===item.id;
          const hot = hovered===item.id && !active;
          return (
            <button key={item.id} onClick={()=>onSelect(item.id)}
              onMouseEnter={()=>setHovered(item.id)} onMouseLeave={()=>setHovered(null)}
              aria-current={active?"page":undefined}
              title={showLabels?undefined:item.label}
              style={{
                display:"flex",alignItems:"center",gap:12,width:"100%",boxSizing:"border-box",
                justifyContent:showLabels?"flex-start":"center",
                paddingTop:11,paddingBottom:11,paddingLeft:showLabels?12:0,paddingRight:showLabels?12:0,
                borderRadius:14,
                border:`1px solid ${active?"rgba(255,255,255,0.2)":"transparent"}`,
                background:active?"linear-gradient(135deg, rgba(29,158,117,0.98) 0%, rgba(19,104,79,0.98) 100%)":hot?"rgba(255,255,255,0.09)":"transparent",
                color:active?"#fff":"rgba(255,255,255,0.76)",
                fontFamily:"var(--font-sans)",fontSize:14,fontWeight:active?600:500,
                textAlign:"left",cursor:"pointer",
                boxShadow:active?"0 12px 24px rgba(5,24,17,0.4)":"none",
                transition:"background 160ms ease, color 160ms ease",
              }}>
              <NavIcon paths={item.icon}/>
              {showLabels && <span style={{whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{item.label}</span>}
            </button>
          );
        })}
      </div>

      <div style={{marginTop:"auto",paddingTop:16}}>
        <div style={{borderTop:"1px solid rgba(255,255,255,0.12)",paddingTop:14,textAlign:showLabels?"left":"center"}}>
          {showLabels && <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.14em",textTransform:"uppercase",color:"rgba(255,255,255,0.55)",marginBottom:4}}>HCP Index</div>}
          <div style={{fontSize:showLabels?24:15,fontWeight:700,lineHeight:1.1}}>{displayHcp}</div>
        </div>
      </div>
    </nav>
  );

  if (isDesktop) {
    return (
      <div style={{position:"sticky",top:0,alignSelf:"flex-start",height:"100dvh",flexShrink:0,zIndex:40}}>
        {panel}
      </div>
    );
  }

  return (
    <>
      <div onClick={onClose} aria-hidden="true" style={{position:"fixed",inset:0,zIndex:88,background:"rgba(8,22,17,0.46)",opacity:open?1:0,pointerEvents:open?"auto":"none",transition:"opacity 220ms ease"}}/>
      <div aria-hidden={!open} style={{position:"fixed",top:0,bottom:0,left:0,zIndex:89,display:"flex",transform:open?"translateX(0)":"translateX(-104%)",visibility:open?"visible":"hidden",boxShadow:open?"0 24px 60px rgba(6,20,15,0.5)":"none",transition:"transform 240ms cubic-bezier(0.22,0.61,0.36,1), visibility 240ms ease"}}>
        {panel}
      </div>
    </>
  );
}

function MobileTopBar({title, displayHcp, onOpenNav, maxWidth}) {
  return (
    <header style={{
      position:"sticky",top:0,zIndex:70,
      paddingTop:"calc(env(safe-area-inset-top) + 8px)",paddingBottom:8,
      paddingLeft:"max(12px, env(safe-area-inset-left))",paddingRight:"max(12px, env(safe-area-inset-right))",
      background:"rgba(240,244,239,0.9)",backdropFilter:"blur(14px)",
      borderBottom:"1px solid var(--color-border-tertiary)",
    }}>
      <div style={{display:"flex",alignItems:"center",gap:12,maxWidth,margin:"0 auto",width:"100%",boxSizing:"border-box"}}>
        <button onClick={onOpenNav} aria-label="Navigation öffnen" style={{display:"grid",placeItems:"center",width:40,height:40,flexShrink:0,padding:0,borderRadius:13,border:"1px solid var(--color-border-tertiary)",background:"rgba(255,255,255,0.92)",color:"var(--color-text-primary)",cursor:"pointer",boxShadow:"var(--shadow-soft)"}}>
          <NavIcon paths={["M4 7h16","M4 12h16","M4 17h16"]}/>
        </button>
        <div style={{minWidth:0,flex:1}}>
          <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.14em",textTransform:"uppercase",color:"var(--color-text-secondary)"}}>Wolf Golf</div>
          <div style={{fontSize:15,fontWeight:600,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{title}</div>
        </div>
        <div style={{textAlign:"right",flexShrink:0}}>
          <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.12em",textTransform:"uppercase",color:"var(--color-text-secondary)"}}>HCP</div>
          <div style={{fontSize:18,fontWeight:700,color:COLORS.hcp,lineHeight:1.1}}>{displayHcp}</div>
        </div>
      </div>
    </header>
  );
}

export default function App() {
  const [db, setDB] = useState(initDB);
  const [view, setView] = useState("dashboard");
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const [navCollapsed, setNavCollapsed] = useState(loadNavCollapsed);
  const [navOpen, setNavOpen] = useState(false);
  const [form, setForm] = useState(null);
  const [courseForm, setCourseForm] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  useEffect(()=>saveDB(db),[db]);

  useEffect(()=>{ if(isDesktop) setNavOpen(false); },[isDesktop]);

  useEffect(()=>{
    if (!navOpen || isDesktop) return;
    const handleKey = e => { if(e.key==="Escape") setNavOpen(false); };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKey);
    return ()=>{
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKey);
    };
  },[navOpen, isDesktop]);

  const toggleNavCollapsed = () => setNavCollapsed(prev=>{ const next=!prev; saveNavCollapsed(next); return next; });
  const selectView = id => { setView(id); setNavOpen(false); };

  const updateDB = fn => setDB(prev=>{ const next=normalizeDB(fn({...prev})); saveDB(next); return next; });

  const saveRound = r => { updateDB(db=>{ if(r.id) db.rounds=db.rounds.map(x=>x.id===r.id?r:x); else { r.id=db.nextRoundId++; r.createdAt=new Date().toISOString(); db.rounds=[...db.rounds,r]; } return db; }); setForm(null); };
  const saveCourse = c => { updateDB(db=>{ if(c.id) db.courses=db.courses.map(x=>x.id===c.id?c:x); else { c.id=db.nextCourseId++; db.courses=[...db.courses,c]; } return db; }); setCourseForm(null); };
  const saveSimulatedRound = r => updateDB(db=>{ if(r.id) db.simulatedRounds=db.simulatedRounds.map(x=>x.id===r.id?r:x); else { r.id=db.nextRoundId++; db.simulatedRounds=[...db.simulatedRounds,r]; } return db; });
  const saveProfile = p => updateDB(db=>{ db.profile=p; return db; });
  const deleteRound = id => { updateDB(db=>{ db.rounds=db.rounds.filter(r=>r.id!==id); return db; }); setDeleteConfirm(null); };
  const deleteSimulatedRound = id => updateDB(db=>{ db.simulatedRounds=db.simulatedRounds.filter(r=>r.id!==id); return db; });
  const clearSimulatedRounds = () => updateDB(db=>{ db.simulatedRounds=[]; return db; });

  const sortedRounds = useMemo(()=>[...db.rounds].sort((a,b)=>b.date.localeCompare(a.date)),[db.rounds]);
  const hcpTimeline = useMemo(()=>buildHandicapTimeline(db.rounds, db.profile.startHcp ?? 54),[db.rounds, db.profile.startHcp]);
  const diffByRoundId = useMemo(()=>new Map(hcpTimeline.map(entry=>[entry.round.id, entry.diff])),[hcpTimeline]);
  const hcpRounds = useMemo(()=>sortedRounds.filter(isHcpEligible),[sortedRounds]);
  const recentTimeline = useMemo(()=>hcpTimeline.slice(-20),[hcpTimeline]);
  const recentDiffs = useMemo(()=>recentTimeline.map(entry=>entry.diff),[recentTimeline]);
  const estimatedHcp = useMemo(()=>hcpTimeline.length ? hcpTimeline[hcpTimeline.length-1].hcpAfter : null,[hcpTimeline]);
  const countingIds = useMemo(()=>{
    const roundCount = recentTimeline.length;
    const take = roundCount > 0 ? getHandicapRule(roundCount).take : 0;
    return new Set(
      [...recentTimeline]
        .sort((a,b)=>a.diff-b.diff)
        .slice(0,take)
        .map(entry=>entry.round.id)
    );
  },[recentTimeline]);
  const hcpRule = useMemo(()=>recentTimeline.length ? getHandicapRule(recentTimeline.length) : null,[recentTimeline]);
  const countingDiffs = useMemo(()=>{
    if (!recentTimeline.length) return [];
    const take = hcpRule?.take ?? 0;
    return [...recentTimeline]
      .map(entry=>entry.diff)
      .sort((a,b)=>a-b)
      .slice(0,take);
  },[recentTimeline, hcpRule]);
  const displayHcp = estimatedHcp??db.profile.startHcp??54;

  const newRound = () => setForm({ date:new Date().toISOString().slice(0,10), mode:"Stableford", format:"Einzel", holes:18, submitted:false, markerSigned:false, nineHoleAllowed:false, playingHcp:displayHcp });

  if (!db.profile.name) return <LandingPage profile={db.profile} onSave={saveProfile}/>;

  const activeNavItem = NAV_ITEMS.find(item=>item.id===view);
  const contentMaxWidth = isDesktop ? (navCollapsed ? 1280 : 1080) : 760;

  return (
    <div style={{display:"flex",alignItems:"stretch",minHeight:"100dvh",width:"100%"}}>
      <SideNav
        view={view}
        onSelect={selectView}
        isDesktop={isDesktop}
        collapsed={navCollapsed}
        onToggleCollapsed={toggleNavCollapsed}
        open={navOpen}
        onClose={()=>setNavOpen(false)}
        profileName={db.profile.name}
        displayHcp={displayHcp}
      />
      <div style={{flex:1,minWidth:0,display:"flex",flexDirection:"column"}}>
        {!isDesktop && <MobileTopBar title={activeNavItem?.label ?? "Dashboard"} displayHcp={displayHcp} onOpenNav={()=>setNavOpen(true)} maxWidth={contentMaxWidth}/>}
        <div style={{maxWidth:contentMaxWidth,margin:"0 auto",padding:contentShellPadding,fontFamily:"var(--font-sans)",color:"var(--color-text-primary)",boxSizing:"border-box",width:"100%"}}>
          <div style={{...cardStyle,display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:18,gap:16,flexWrap:"wrap",padding:isDesktop?"22px 24px":"18px 20px",background:"linear-gradient(140deg, rgba(20,46,37,0.96) 0%, rgba(18,57,44,0.94) 45%, rgba(29,158,117,0.76) 100%)",color:"#fff",position:"relative",overflow:"hidden"}}>
            <div style={{position:"absolute",inset:0,background:"radial-gradient(circle at top right, rgba(255,255,255,0.16), transparent 28%), linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)",backgroundSize:"auto, 24px 24px",opacity:0.4,pointerEvents:"none"}}/>
            <div>
              {isDesktop && <div style={{fontSize:12,fontWeight:700,letterSpacing:"0.14em",textTransform:"uppercase",opacity:0.72,marginBottom:8}}>Personal Golf Office</div>}
              <div style={{fontSize:isDesktop?28:22,fontWeight:600,marginBottom:6}}>{isDesktop ? "Wolf Golf" : db.profile.name}</div>
              <div style={{fontSize:14,color:"rgba(255,255,255,0.72)"}}>{isDesktop ? `${db.profile.name} · DGV · WHS` : "DGV · WHS"}</div>
            </div>
            <div style={{textAlign:"right",marginLeft:"auto",minWidth:180,position:"relative"}}>
              <HcpTooltip
                  displayHcp={displayHcp}
                  estimatedHcp={estimatedHcp}
                  roundCount={recentTimeline.length}
                  take={hcpRule?.take ?? 0}
                  adjustment={hcpRule?.adj ?? 0}
                  countingDiffs={countingDiffs}
                >
                <div style={{display:"inline-flex",alignItems:"center",justifyContent:"flex-end",gap:6,marginBottom:4}}>
                  <span style={{fontSize:11,color:"rgba(255,255,255,0.68)"}}>{estimatedHcp?"Aktueller HCP Index":"Start-HCP"}</span>
                  <span style={{width:18,height:18,borderRadius:"50%",border:"1px solid rgba(255,255,255,0.22)",background:"rgba(255,255,255,0.08)",color:"#fff",fontSize:11,fontWeight:700,display:"inline-flex",alignItems:"center",justifyContent:"center"}}>?</span>
                </div>
                <div style={{fontSize:44,fontWeight:700,color:"#fff",lineHeight:1}}>{displayHcp}</div>
                <div style={{fontSize:11,color:"rgba(255,255,255,0.68)",marginTop:6}}>{estimatedHcp?`aus ${Math.min(hcpRounds.length,20)} HCP-wirks. Runden`:"noch keine gewerteten Runden"}</div>
              </HcpTooltip>
            </div>
          </div>

          {view==="dashboard" && <Dashboard rounds={sortedRounds} hcpRounds={hcpRounds} recentDiffs={recentDiffs} estimatedHcp={estimatedHcp} onNew={()=>{newRound();setView("rounds");}} hcpTimeline={hcpTimeline} diffByRoundId={diffByRoundId} variant="focus"/>}
          {view==="simulator" && <HcpSimulator courses={db.courses} rounds={db.rounds} startHcp={db.profile.startHcp ?? 54} simulatedRounds={db.simulatedRounds} onAddRound={saveSimulatedRound} onDeleteRound={deleteSimulatedRound} onClearRounds={clearSimulatedRounds}/>}
          {view==="rounds" && <RoundList rounds={sortedRounds} courses={db.courses} onNew={newRound} onEdit={r=>setForm({...r})} onDelete={id=>setDeleteConfirm(id)} countingIds={countingIds} diffByRoundId={diffByRoundId}/>}
          {view==="courses" && <CourseList courses={db.courses} onNew={()=>setCourseForm({name:"",courseRating:"",slopeRating:"",par:36,tee:"Gelb",notes:"",nineHolePhcpFactor:0.5})} onEdit={c=>setCourseForm({...c})}/>}
          {view==="profile" && <ProfileForm profile={db.profile} onSave={saveProfile}/>}
          {view==="data" && <DataPortability
            db={db}
            onJsonImport={data=>{
              const normalized = normalizeDB(data);
              saveDB(normalized);
              setDB(normalized);
            }}
            onGolfDePdfImport={(parsedRounds, mode)=>{
              const result = mode === "replace"
                ? replaceGolfDeImport(db, parsedRounds)
                : mergeGolfDeImport(db, parsedRounds);
              saveDB(result.db);
              setDB(result.db);
              return result.summary;
            }}
          />}
          {view==="info" && <HcpInfo/>}

          <UpdateAppPrompt/>
          <InstallAppPrompt/>

          {form && <Modal title={form.id?"Runde bearbeiten":"Neue Runde"} onClose={()=>setForm(null)}><RoundForm initial={form} courses={db.courses} currentHcp={displayHcp} onSave={saveRound} onCancel={()=>setForm(null)}/></Modal>}
          {courseForm && <Modal title={courseForm.id?"Platz bearbeiten":"Neuer Platz"} onClose={()=>setCourseForm(null)}><CourseForm initial={courseForm} rounds={db.rounds} startHcp={db.profile.startHcp ?? 54} onSave={saveCourse} onCancel={()=>setCourseForm(null)}/></Modal>}
          {deleteConfirm && <Modal title="Runde löschen?" onClose={()=>setDeleteConfirm(null)}>
            <p style={{color:COLORS.textSec,fontSize:14}}>Diese Runde wird unwiderruflich gelöscht.</p>
            <div style={{display:"flex",gap:8,marginTop:16}}>
              <button onClick={()=>deleteRound(deleteConfirm)} style={{padding:"8px 16px",borderRadius:"var(--border-radius-md)",background:"#E24B4A",color:"#fff",border:"none",cursor:"pointer",fontWeight:500}}>Löschen</button>
              <button onClick={()=>setDeleteConfirm(null)} style={{padding:"8px 16px",borderRadius:"var(--border-radius-md)",background:"transparent",border:`0.5px solid ${COLORS.border}`,cursor:"pointer",color:"var(--color-text-primary)"}}>Abbrechen</button>
            </div>
          </Modal>}

          <AppFooter/>
        </div>
      </div>
    </div>
  );
}
