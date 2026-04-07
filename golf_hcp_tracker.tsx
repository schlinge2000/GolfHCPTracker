import { useState, useEffect, useMemo, type CSSProperties, type ReactNode } from "react";
import pdfWorkerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";

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
  const bytes = new Uint8Array(await file.arrayBuffer());
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
    const matches = [...block.matchAll(regex)];

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
    const diffToken = compact.at(-1);
    const gbeToken = compact.at(-2);
    const artToken = compact.at(-3);
    const holesToken = compact.at(-4);
    const clubNumberToken = compact.at(-5);
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

const HCP_RULES = [
  {maxRounds:2,take:1,adj:-2},
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

function round1(value) {
  return Math.round(value * 10) / 10;
}

function getGrossScore(r) {
  const gbe = parseFloat(r.gbe);
  if (Number.isFinite(gbe)) return gbe;
  const adjustedGross = parseFloat(r.adjustedGross);
  return Number.isFinite(adjustedGross) ? adjustedGross : null;
}

function getHandicapRule(roundCount) {
  return HCP_RULES.find(rule=>roundCount<=rule.maxRounds) || HCP_RULES[HCP_RULES.length-1];
}

function calcExpectedNineHoleDiff(handicapIndex) {
  const base = Math.min(54, Math.max(0, parseFloat(handicapIndex) || 54));
  if (base >= 54) return 28.4;
  return round1(((base * 1.04) + 2.4) / 2);
}

function getNineHolePhcpFactor(course) {
  const factor = parseFloat(course?.nineHolePhcpFactor);
  return Number.isFinite(factor) && factor > 0 ? factor : 0.5;
}

function calcCourseHandicap(handicapIndex, courseRating, slopeRating, par) {
  const hi = parseFloat(handicapIndex);
  const cr = parseFloat(courseRating);
  const sr = parseFloat(slopeRating);
  const scorePar = parseInt(par);
  if (!Number.isFinite(hi) || !Number.isFinite(cr) || !Number.isFinite(sr) || !Number.isFinite(scorePar)) return null;
  return (hi * sr) / 113 + (cr - scorePar);
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

  const nextDiffs = [...recentDiffs, diff].slice(-20);
  const nextHcp = calcHcp(nextDiffs);
  const rule = getHandicapRule(nextDiffs.length);
  const sortedEntries = nextDiffs.map((value, index)=>({value, index})).sort((a,b)=>a.value-b.value || a.index-b.index);
  const countingEntries = sortedEntries.slice(0, rule.take);
  const countingDiffs = countingEntries.map(entry=>entry.value);

  return {
    diff,
    nextHcp,
    nextDiffs,
    rule,
    countingDiffs,
    wouldCount: countingEntries.some(entry=>entry.index===nextDiffs.length-1),
  };
}

function calcScoreDiff(r, handicapIndexForNineHole) {
  const reportedDiff = parseFloat(r.reportedDiff);
  if (r?.source === "golf.de-pdf" && Number.isFinite(reportedDiff)) {
    return round1(reportedDiff);
  }

  const cr=parseFloat(r.courseRating), sr=parseFloat(r.slopeRating);
  const gross=getGrossScore(r);
  if (!cr||!sr||gross===null) return null;
  if (parseInt(r.holes)===9) {
    const playedNineDiff = ((gross-cr)*113)/sr;
    return round1(playedNineDiff + calcExpectedNineHoleDiff(handicapIndexForNineHole));
  }
  return round1(((gross-cr)*113)/sr);
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
  const diffs = [];
  let currentHcp = Math.min(54, Math.max(0, parseFloat(startHcp) || 54));

  return eligibleRounds.map(round=>{
    const preRoundHcp = currentHcp;
    const diff = calcScoreDiff(round, preRoundHcp);
    if (diff===null) return null;
    diffs.push(diff);
    currentHcp = calcHcp(diffs) ?? currentHcp;
    return { round, diff, hcpAfter: currentHcp, preRoundHcp };
  }).filter(Boolean);
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

function calcHcp(diffs) {
  if (!diffs.length) return null;
  const n = Math.min(diffs.length, 20);
  const {take,adj} = getHandicapRule(n);
  const best = [...diffs].sort((a,b)=>a-b).slice(0,take);
  const avg = best.reduce((s,d)=>s+d,0)/best.length;
  return Math.min(54, round1(avg + adj));
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
  const countingAverage = countingDiffs.length ? round1(countingDiffs.reduce((sum, diff)=>sum+diff,0) / countingDiffs.length) : null;

  return (
    <div
      style={{position:"relative",display:"inline-block"}}
      onMouseEnter={()=>setOpen(true)}
      onMouseLeave={()=>setOpen(false)}
    >
      <div onClick={()=>setOpen(prev=>!prev)} style={{cursor:"help"}}>
        {children}
      </div>
      {open && (
        <div
          style={{
            position:"absolute",
            top:"calc(100% + 8px)",
            right:0,
            width:280,
            background:"linear-gradient(180deg, rgba(18,33,27,0.98) 0%, rgba(24,44,35,0.96) 100%)",
            border:"1px solid rgba(255,255,255,0.12)",
            borderRadius:"var(--border-radius-md)",
            boxShadow:"0 18px 44px rgba(17, 17, 17, 0.28)",
            padding:"14px 15px",
            zIndex:30,
            textAlign:"left",
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
        </div>
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

function Modal({title, children, onClose}) {
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.35)",zIndex:100,display:"flex",alignItems:"flex-start",justifyContent:"center",padding:"max(24px, calc(env(safe-area-inset-top) + 16px)) max(16px, calc(env(safe-area-inset-right) + 12px)) max(24px, calc(env(safe-area-inset-bottom) + 16px)) max(16px, calc(env(safe-area-inset-left) + 12px))",overflowY:"auto"}}
      onClick={e=>{if(e.target===e.currentTarget) onClose();}}>
      <div style={{...cardStyle,padding:"20px 24px",width:"100%",maxWidth:520}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div style={{fontWeight:500,fontSize:16,color:"#111"}}>{title}</div>
          <button onClick={onClose} style={{background:"transparent",border:"none",cursor:"pointer",fontSize:18,color:"#888",lineHeight:1}}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ScoreChart({data, projectedStartIndex=null}) {
  const w=680,h=200,pad={t:16,r:20,b:32,l:44};
  const diffs=data.map(d=>d.diff).filter(x=>x!==null);
  if (!diffs.length) return null;
  const min=Math.min(...diffs)-2, max=Math.max(...diffs)+2;
  const dates=data.map(d=>new Date(d.date).getTime());
  const tMin=Math.min(...dates), tMax=Math.max(...dates);
  const sx=t=>tMax===tMin ? pad.l : pad.l+((t-tMin)/(tMax-tMin))*(w-pad.l-pad.r);
  const sy=v=>pad.t+((max-v)/(max-min))*(h-pad.t-pad.b);
  const visible=data.filter(d=>d.diff!==null);
  const actualVisible = projectedStartIndex===null ? visible : visible.slice(0, projectedStartIndex);
  const projectedVisible = projectedStartIndex===null ? [] : visible.slice(Math.max(0, projectedStartIndex-1));
  const actualPts=actualVisible.map(d=>`${sx(new Date(d.date).getTime())},${sy(d.diff)}`).join(" ");
  const projectedPts=projectedVisible.map(d=>`${sx(new Date(d.date).getTime())},${sy(d.diff)}`).join(" ");
  const fmt=t=>new Date(t).toLocaleDateString("de-DE",{day:"2-digit",month:"2-digit",year:"2-digit"});
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{width:"100%",height:"auto",display:"block"}}>
      {[Math.ceil(min),Math.round((min+max)/2),Math.floor(max)].map(v=>(
        <g key={v}>
          <line x1={pad.l} x2={w-pad.r} y1={sy(v)} y2={sy(v)} stroke="#D3D1C7" strokeWidth={0.5}/>
          <text x={pad.l-6} y={sy(v)+4} fontSize={10} textAnchor="end" fill="#888">{v}</text>
        </g>
      ))}
      {actualPts && <polyline points={actualPts} fill="none" stroke={COLORS.hcp} strokeWidth={1.5}/>}
      {projectedPts && <polyline points={projectedPts} fill="none" stroke="#C56B1A" strokeWidth={1.5} strokeDasharray="5 4"/>}
      {visible.map((d,i)=>(
        <circle key={i} cx={sx(new Date(d.date).getTime())} cy={sy(d.diff)} r={3} fill={projectedStartIndex!==null && i>=projectedStartIndex ? "#C56B1A" : d.mode==="Stableford"?COLORS.stableford:COLORS.stroke}/>
      ))}
      <text x={pad.l} y={h-4} fontSize={10} fill="#888">{fmt(tMin)}</text>
      {tMax!==tMin && <text x={w-pad.r} y={h-4} fontSize={10} textAnchor="end" fill="#888">{fmt(tMax)}</text>}
    </svg>
  );
}

function HcpTrendChart({trend, projectedStartIndex=null}) {
  const w=680,h=180,pad={t:16,r:20,b:28,l:44};
  const vals=trend.map(t=>t.hcp);
  const min=Math.min(...vals)-1, max=Math.max(...vals)+1;
  const dates=trend.map(t=>new Date(t.date).getTime());
  const tMin=Math.min(...dates), tMax=Math.max(...dates);
  const sx=t=>tMax===tMin ? pad.l : pad.l+((t-tMin)/(tMax-tMin))*(w-pad.l-pad.r);
  const sy=v=>pad.t+((max-v)/(max-min))*(h-pad.t-pad.b);
  const actualTrend = projectedStartIndex===null ? trend : trend.slice(0, projectedStartIndex);
  const projectedTrend = projectedStartIndex===null ? [] : trend.slice(Math.max(0, projectedStartIndex-1));
  const actualPts=actualTrend.map(t=>`${sx(new Date(t.date).getTime())},${sy(t.hcp)}`).join(" ");
  const projectedPts=projectedTrend.map(t=>`${sx(new Date(t.date).getTime())},${sy(t.hcp)}`).join(" ");
  const fmt=t=>new Date(t).toLocaleDateString("de-DE",{day:"2-digit",month:"2-digit",year:"2-digit"});
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{width:"100%",height:"auto",display:"block"}}>
      {[Math.floor(min),Math.round((min+max)/2),Math.ceil(max)].map(v=>(
        <g key={v}>
          <line x1={pad.l} x2={w-pad.r} y1={sy(v)} y2={sy(v)} stroke="#D3D1C7" strokeWidth={0.5}/>
          <text x={pad.l-6} y={sy(v)+4} fontSize={10} textAnchor="end" fill="#888">{v}</text>
        </g>
      ))}
      {actualPts && <polyline points={actualPts} fill="none" stroke={COLORS.hcp} strokeWidth={2}/>}
      {projectedPts && <polyline points={projectedPts} fill="none" stroke="#C56B1A" strokeWidth={2} strokeDasharray="6 4"/>}
      {trend.map((t,i)=><circle key={i} cx={sx(new Date(t.date).getTime())} cy={sy(t.hcp)} r={3} fill={projectedStartIndex!==null && i>=projectedStartIndex ? "#C56B1A" : COLORS.hcp}/>)}
      <text x={pad.l} y={h-4} fontSize={10} fill="#888">{fmt(tMin)}</text>
      {tMax!==tMin && <text x={w-pad.r} y={h-4} fontSize={10} textAnchor="end" fill="#888">{fmt(tMax)}</text>}
    </svg>
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
  const hcpEligible = rounds.filter(isHcpEligible);
  const take = hcpEligible.length > 0 ? getHandicapRule(Math.min(hcpEligible.length, 20)).take : 0;

  const filtered = rounds.filter(r=>{
    if (filter==="hcp") return isHcpEligible(r);
    if (filter==="no_hcp") return !isHcpEligible(r);
    if (filter==="counting") return countingIds.has(r.id);
    return true;
  });
  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <div style={{display:"flex",gap:6}}>
          {[["all","Alle"],["hcp","HCP-wirksam"],["counting",`Zählt aktuell (${take})`],["no_hcp","Nicht wirksam"]].map(([v,l])=>(
            <button key={v} onClick={()=>setFilter(v)} style={{fontSize:12,padding:"4px 10px",borderRadius:"var(--border-radius-md)",background:filter===v?COLORS.hcp:"transparent",color:filter===v?"#fff":"var(--color-text-secondary)",border:`0.5px solid ${filter===v?COLORS.hcp:"var(--color-border-tertiary)"}`,cursor:"pointer"}}>{l}</button>
          ))}
        </div>
        <button onClick={onNew} style={{padding:"8px 14px",borderRadius:"var(--border-radius-md)",background:COLORS.hcp,color:"#fff",border:"none",cursor:"pointer",fontSize:13,fontWeight:500}}>+ Neue Runde</button>
      </div>
      {filtered.length===0 && <div style={{color:"var(--color-text-secondary)",fontSize:14,padding:"24px 0"}}>Keine Runden gefunden.</div>}
      {filtered.map(r=><RoundRow key={r.id} round={r} onEdit={()=>onEdit(r)} onDelete={()=>onDelete(r.id)} counting={countingIds.has(r.id)} diffByRoundId={diffByRoundId}/>)}
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

function Dashboard({rounds, hcpRounds, recentDiffs, estimatedHcp, onNew, hcpTimeline, diffByRoundId, projectedStartIndex=null, simulatedRoundIds=new Set(), title=null, recentTitle="Letzte Runden", actionArea=null, emptyText="Noch keine Runden erfasst"}) {
  const avgDiff = recentDiffs.length?(recentDiffs.reduce((s,d)=>s+d,0)/recentDiffs.length).toFixed(1):null;
  const chartData = useMemo(()=>hcpTimeline.map((entry,i)=>({x:i+1,diff:entry.diff,mode:entry.round.mode,date:entry.round.date})),[hcpTimeline]);
  const trendData = useMemo(()=>hcpTimeline.map((entry,i)=>({i:i+1,hcp:entry.hcpAfter,date:entry.round.date})),[hcpTimeline]);
  const summaryCards = [["Runden gesamt",rounds.length],["HCP-wirksam",hcpRounds.length],["Ø Differenzial",avgDiff??"–"],["Bestes Diff",recentDiffs.length?Math.min(...recentDiffs).toFixed(1):"–"]];
  if (simulatedRoundIds.size) summaryCards.push(["Simuliert", simulatedRoundIds.size]);

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

      {hcpRounds.length>0 && <HcpRoundsTable rounds={hcpRounds} diffByRoundId={diffByRoundId} simulatedRoundIds={simulatedRoundIds}/>}

      {(chartData.length>0 || trendData.length>=2) && (
        <div style={{display:"grid",gridTemplateColumns:trendData.length>=2&&chartData.length>0?"1fr 1fr":"1fr",gap:16,marginBottom:24}}>
          {chartData.length>0 && (
            <div>
              <div style={{fontSize:14,fontWeight:500,marginBottom:12}}>Score Differenzials</div>
              <ScoreChart data={chartData} projectedStartIndex={projectedStartIndex}/>
            </div>
          )}
          {trendData.length>=2 && (
            <div>
              <div style={{fontSize:14,fontWeight:500,marginBottom:10}}>HCP-Entwicklung</div>
              <HcpTrendChart trend={trendData} projectedStartIndex={projectedStartIndex}/>
            </div>
          )}
        </div>
      )}

      {rounds.length===0 ? (
        <div style={{textAlign:"center",padding:"40px 0",color:"var(--color-text-secondary)"}}>
          <div style={{fontSize:32,marginBottom:12}}>⛳</div>
          <div style={{fontSize:15,marginBottom:16}}>{emptyText}</div>
          <button onClick={onNew} style={{padding:"10px 20px",borderRadius:"var(--border-radius-md)",background:COLORS.hcp,color:"#fff",border:"none",cursor:"pointer",fontWeight:500,fontSize:14}}>Erste Runde erfassen</button>
        </div>
      ) : (
        <div>
          <div style={{fontSize:14,fontWeight:500,marginBottom:10}}>{recentTitle}</div>
          {rounds.slice(0,8).map(r=><RoundRow key={r.id} round={r} compact diffByRoundId={diffByRoundId}/>)}
        </div>
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
    a.download = `golf-hcp-export-${new Date().toISOString().slice(0,10)}.json`;
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
              <span>{i===0 ? `1–${rule.maxRounds}` : `${HCP_RULES[i-1].maxRounds+1}–${rule.maxRounds}`}</span>
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
          <div style={{fontSize:12,fontWeight:700,letterSpacing:"0.12em",textTransform:"uppercase",color:"#1D9E75",marginBottom:8}}>Golf HCP Tracker</div>
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
            Fuer eine oeffentlich bereitgestellte App in Deutschland brauchst du in vielen Faellen ein Impressum und oft auch eine Datenschutzerklaerung. Die konkreten Angaben muessen vom Betreiber ergaenzt werden.
          </div>
        </div>
      </div>
      <div style={{marginTop:16,paddingTop:14,borderTop:"1px solid var(--color-border-tertiary)",display:"flex",justifyContent:"space-between",gap:12,flexWrap:"wrap",fontSize:12,color:"var(--color-text-secondary)"}}>
        <span>{year} Golf HCP Tracker</span>
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

export default function App() {
  const [db, setDB] = useState(initDB);
  const [view, setView] = useState("dashboard");
  const [form, setForm] = useState(null);
  const [courseForm, setCourseForm] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  useEffect(()=>saveDB(db),[db]);

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

  return (
    <div style={{maxWidth:760,margin:"0 auto",padding:appShellPadding,fontFamily:"var(--font-sans)",color:"var(--color-text-primary)",boxSizing:"border-box",width:"100%"}}>
      <div style={{...cardStyle,display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:18,gap:16,flexWrap:"wrap",padding:"22px 24px",background:"linear-gradient(140deg, rgba(20,46,37,0.96) 0%, rgba(18,57,44,0.94) 45%, rgba(29,158,117,0.76) 100%)",color:"#fff",position:"relative",overflow:"hidden"}}>
        <div style={{position:"absolute",inset:0,background:"radial-gradient(circle at top right, rgba(255,255,255,0.16), transparent 28%), linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)",backgroundSize:"auto, 24px 24px",opacity:0.4,pointerEvents:"none"}}/>
        <div>
          <div style={{fontSize:12,fontWeight:700,letterSpacing:"0.14em",textTransform:"uppercase",opacity:0.72,marginBottom:8}}>Personal Golf Office</div>
          <div style={{fontSize:28,fontWeight:600,marginBottom:6}}>Golf HCP Tracker</div>
          <div style={{fontSize:14,color:"rgba(255,255,255,0.72)"}}>{db.profile.name} · DGV · WHS</div>
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

      <div style={{display:"flex",gap:6,marginBottom:22,padding:"8px",background:"rgba(255,255,255,0.7)",border:"1px solid var(--color-border-tertiary)",borderRadius:"18px",boxShadow:"var(--shadow-soft)",overflowX:"auto",WebkitOverflowScrolling:"touch",scrollbarWidth:"none",backdropFilter:"blur(12px)"}}>
        {[["dashboard","Dashboard"],["simulator","Simulator"],["rounds","Runden"],["courses","Plätze"],["profile","Profil"],["data","Daten"],["info","HCP-Info"]].map(([id,label])=>(
          <button key={id} onClick={()=>setView(id)} style={{padding:"8px 14px",borderRadius:"12px",background:view===id?"linear-gradient(135deg, #1D9E75 0%, #14684f 100%)":"transparent",color:view===id?"#fff":COLORS.textSec,border:"none",cursor:"pointer",fontWeight:view===id?600:500,fontSize:14,whiteSpace:"nowrap",flexShrink:0,boxShadow:view===id?"0 10px 20px rgba(29,158,117,0.22)":"none"}}>{label}</button>
        ))}
      </div>

      {view==="dashboard" && <Dashboard rounds={sortedRounds} hcpRounds={hcpRounds} recentDiffs={recentDiffs} estimatedHcp={estimatedHcp} onNew={()=>{newRound();setView("rounds");}} hcpTimeline={hcpTimeline} diffByRoundId={diffByRoundId}/>}
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
  );
}
