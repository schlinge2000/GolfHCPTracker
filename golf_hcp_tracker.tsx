import { useState, useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import pdfWorkerSrc from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import qrcode from "qrcode-generator";

import { buildShareUrl, describeShareCard, parseShareHash, parseShareLink, type GameCard, type ShareCard } from "./src/shareCard";
import { classifyCameraError, createDetector, drawFrame, isCameraSupported, startCamera, stopCamera, type CameraFailure } from "./src/qrScanner";
import { calcCourseHandicap, calcExpectedNineHoleDiff, calcScoreDiff, round1, getGrossScore, calcHcp, getHandicapRule, HCP_RULES, applyBeginnerRetention, exceptionalScoreReduction, buildIndexTimeline, parseHandicapIndex } from "./src/hcpMath";
import { suggestHoles, normalizeHoles, totalPar, buildAllocations, scoreMatchplay, scoreSkins, scoreNassau, scoreWolf, scoreBingoBangoBongo, nassauSegments, BBB_AWARDS, stablefordFromHoles, playedHoleCount, DEFAULT_HANDICAP_CONFIG } from "./src/gameMath";
import { fetchUsageStats, isUsagePingEnabled, setUsagePingEnabled, whenUsagePingSettled, USAGE_ID_RETENTION_DAYS, type UsageStats } from "./src/usagePing";

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

// Zentrale Pflege der rechtlichen Angaben: Impressum und Datenschutzerklärung lesen
// ausschließlich hier. Seit die App unter einer eigenen Domain öffentlich erreichbar
// ist, dient sie nicht mehr ausschließlich persönlichen oder familiären Zwecken –
// Name, ladungsfähige Anschrift und E-Mail sind daher Pflichtangaben
// (§ 18 Abs. 1 MStV, § 5 DDG) und keine freiwillige Zugabe mehr.
const LEGAL = {
  site: {
    domain: "wolfgolf.club",
    url: "https://wolfgolf.club",
  },
  operator: {
    name: "Christian Mießen",
    street: "Euchener Straße 59",
    postalCity: "52146 Würselen",
    country: "Deutschland",
    // Alias auf der eigenen Domain, muss als Weiterleitung auf ein echtes Postfach
    // eingerichtet sein – eine im Impressum genannte, nicht erreichbare Adresse ist
    // selbst ein Mangel.
    email: "kontakt@wolfgolf.club",
    phone: "",        // optional, gesetzlich nicht erforderlich
    contactUrl: GITHUB_ISSUES_URL,
    contactLabel: "Issue im GitHub-Repository",
  },
  hosting: {
    provider: "Netlify, Inc.",
    address: "101 2nd Street, San Francisco, CA 94105, USA",
    privacyUrl: "https://www.netlify.com/privacy/",
    privacyLabel: "netlify.com/privacy",
  },
  updatedAt: "2026-08-07",
};

const LEGAL_REQUIRED_FIELDS: [string, string][] = [
  ["Straße und Hausnummer", LEGAL.operator.street],
  ["PLZ und Ort", LEGAL.operator.postalCity],
  ["Kontakt-E-Mail", LEGAL.operator.email],
];

function missingLegalFields() {
  return LEGAL_REQUIRED_FIELDS.filter(([,value])=>!String(value||"").trim()).map(([label])=>label);
}

function formatLegalDate(iso) {
  const parts = String(iso||"").split("-");
  return parts.length===3 ? `${parts[2]}.${parts[1]}.${parts[0]}` : String(iso||"");
}

const LEGAL_VIEW_LABELS = { impressum:"Impressum", datenschutz:"Datenschutzerklärung" };
const isLegalView = view => view==="impressum" || view==="datenschutz";
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
  // holeCount/holeData tragen die Scorekarte (Par und Vorgabenverteilung je Loch)
  // und werden nur von der Games-Rubrik gebraucht. Ohne sie bleibt der Platz
  // voll funktionsfähig – die Daten werden dann beim ersten Spiel vorgeschlagen.
  const holeCount = parseInt(course?.holeCount) === 9 ? 9 : parseInt(course?.holeCount) === 18 ? 18 : null;
  const hasHoleData = Array.isArray(course?.holeData) && course.holeData.length > 0;
  const normalized = {
    ...course,
    nineHolePhcpFactor: Number.isFinite(factor) && factor > 0 ? round3(factor) : 0.5,
  };
  if (holeCount || hasHoleData) {
    const count = holeCount ?? (course.holeData.length === 9 ? 9 : 18);
    normalized.holeCount = count;
    normalized.holeData = normalizeHoles(course?.holeData, count, course?.par);
  }
  return normalized;
}

function normalizePlayer(player) {
  const hcpIndex = parseFloat(player?.hcpIndex);
  return {
    ...player,
    name: String(player?.name ?? "").trim(),
    hcpIndex: Number.isFinite(hcpIndex) ? round1(hcpIndex) : 54,
    isMe: Boolean(player?.isMe),
  };
}

function normalizeGame(game) {
  const holeCount = parseInt(game?.holeCount) === 9 ? 9 : 18;
  const holes = normalizeHoles(game?.holes, holeCount, game?.coursePar);
  const scores = Array.from({length: holeCount}, (_, index)=>{
    const row = Array.isArray(game?.scores) ? game.scores[index] : null;
    return row && typeof row === "object" ? {...row} : {};
  });
  return {
    ...game,
    holeCount,
    holes,
    scores,
    formats: Array.isArray(game?.formats) ? game.formats : [],
    participants: Array.isArray(game?.participants) ? game.participants : [],
    wolfChoices: Array.from({length: holeCount}, (_, index)=>{
      const entry = Array.isArray(game?.wolfChoices) ? game.wolfChoices[index] : null;
      return entry && typeof entry === "object" ? {partnerId: entry.partnerId ?? null, blind: Boolean(entry.blind)} : {partnerId:null, blind:false};
    }),
    bbbAwards: Array.from({length: holeCount}, (_, index)=>{
      const entry = Array.isArray(game?.bbbAwards) ? game.bbbAwards[index] : null;
      return entry && typeof entry === "object" ? {bingo: entry.bingo ?? null, bango: entry.bango ?? null, bongo: entry.bongo ?? null} : {bingo:null, bango:null, bongo:null};
    }),
    nassauPresses: Array.isArray(game?.nassauPresses)
      ? game.nassauPresses.filter(press=>Number.isFinite(press?.from) && typeof press?.segment === "string")
      : [],
    handicap: {
      mode: game?.handicap?.mode ?? DEFAULT_HANDICAP_CONFIG.mode,
      percent: Number.isFinite(parseFloat(game?.handicap?.percent)) ? parseFloat(game.handicap.percent) : DEFAULT_HANDICAP_CONFIG.percent,
    },
    stake: {
      skin: parseFloat(game?.stake?.skin) || 1,
      match: parseFloat(game?.stake?.match) || 1,
      nassau: parseFloat(game?.stake?.nassau) || 1,
      point: parseFloat(game?.stake?.point) || 1,
    },
    status: game?.status === "finished" ? "finished" : "running",
  };
}

function normalizeDB(data) {
  const safe = data && typeof data === "object" ? data : {};
  const courses = Array.isArray(safe.courses) ? safe.courses.map(normalizeCourse) : [];
  // Simulationsrunden lagen früher in einer eigenen Liste (Rubrik "Simulator").
  // Inzwischen sind sie normale Runden mit dem Kennzeichen "simulated", deshalb
  // wandern Altbestände beim Laden in die Rundenliste.
  const legacySimulated = Array.isArray(safe.simulatedRounds)
    ? safe.simulatedRounds.map(round=>({...round, simulated:true}))
    : [];
  const rounds = [...(Array.isArray(safe.rounds) ? safe.rounds : []), ...legacySimulated];
  const players = Array.isArray(safe.players) ? safe.players.map(normalizePlayer) : [];
  const games = Array.isArray(safe.games) ? safe.games.map(normalizeGame) : [];
  const nextRoundId = Number.isFinite(safe.nextRoundId)
    ? safe.nextRoundId
    : rounds.reduce((maxId, round)=>Math.max(maxId, round.id || 0), 0) + 1;
  const nextCourseId = Number.isFinite(safe.nextCourseId)
    ? safe.nextCourseId
    : courses.reduce((maxId, course)=>Math.max(maxId, course.id || 0), 0) + 1;
  const nextPlayerId = Number.isFinite(safe.nextPlayerId)
    ? safe.nextPlayerId
    : players.reduce((maxId, player)=>Math.max(maxId, player.id || 0), 0) + 1;
  const nextGameId = Number.isFinite(safe.nextGameId)
    ? safe.nextGameId
    : games.reduce((maxId, game)=>Math.max(maxId, game.id || 0), 0) + 1;

  return {
    courses,
    rounds,
    players,
    games,
    profile: safe.profile || {name:"", startHcp:54},
    nextRoundId,
    nextCourseId,
    nextPlayerId,
    nextGameId,
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

// Erzeugt die Schritt-für-Schritt-Erklärung für die Vorschau im Rundenformular.
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
  const start = Math.min(54, Math.max(0, parseHandicapIndex(startHcp)));
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

function RoundForm({initial, courses, currentHcp, recentDiffs=[], nextSimulationDate=null, onSave, onCancel}) {
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

  // Eine Simulation soll im Dashboard wirken, also setzt der Haken die
  // Wertbarkeits-Kennzeichen gleich mit. Sie bleiben editierbar, falls jemand
  // bewusst eine nicht wertbare Runde durchspielen will.
  const toggleSimulated = on => setR(prev=>{
    if (!on) return {...prev, simulated:false};
    return {
      ...prev,
      simulated:true,
      submitted:true,
      markerSigned:true,
      nineHoleAllowed:parseInt(prev.holes)===9 ? true : prev.nineHoleAllowed,
      // Ein Was-wäre-wenn gilt meist der nächsten Runde – solange das Datum
      // unangetastet ist, springt es auf den Tag nach der letzten Runde.
      date:(!prev.id && nextSimulationDate && prev.date===initial.date) ? nextSimulationDate : prev.date,
    };
  });

  const previewRound = useMemo(()=>({
    holes:r.holes,
    mode:r.mode,
    courseRating:r.courseRating,
    slopeRating:r.slopeRating,
    par:r.par,
    playingHcp:r.playingHcp,
    adjustedGross:r.mode==="Stableford"
      ? calcAdjustedGrossFromStableford({ par, playingHcp:phcp, holes:r.holes, stablefordPoints:parseInt(r.stablefordPoints) })
      : parseInt(r.adjustedGross),
    gbe:r.gbe,
  }), [r, par, phcp]);

  // Vorschau nur für neue Simulationsrunden: bei einer bereits gespeicherten
  // Runde steckt ihr Differenzial schon im Wertungsfenster, die Rechnung wäre
  // doppelt.
  const preview = useMemo(()=>{
    if (!r.simulated || r.id || !eligible) return null;
    if (getGrossScore(previewRound)===null) return null;
    return buildProjectedHandicap({ recentDiffs, currentHcp, round:previewRound });
  }, [r.simulated, r.id, eligible, previewRound, recentDiffs, currentHcp]);

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
      <div style={{padding:"10px 14px",borderRadius:"var(--border-radius-md)",border:`1px solid ${r.simulated?"rgba(197,107,26,0.32)":"var(--color-border-tertiary)"}`,background:r.simulated?"linear-gradient(180deg, #fff9f2 0%, #fff1df 100%)":"rgba(255,255,255,0.6)",marginBottom:14}}>
        <label style={{display:"flex",alignItems:"center",gap:8,fontSize:13,cursor:"pointer",fontWeight:r.simulated?600:400,color:r.simulated?"#9a5314":"var(--color-text-primary)"}}>
          <input type="checkbox" checked={r.simulated||false} onChange={e=>toggleSimulated(e.target.checked)}/>
          Simulation (was wäre wenn)
        </label>
        <div style={{fontSize:12,color:"var(--color-text-secondary)",marginTop:6,lineHeight:1.5}}>
          Läuft im Dashboard mit, bleibt aber überall orange als Simulation markiert. Löschen genügt, um zum echten Index zurückzukehren.
        </div>
      </div>
      <div style={{padding:"10px 14px",borderRadius:"var(--border-radius-md)",background:eligible?(r.simulated?"#FFF1DF":"#E1F5EE"):"#F1EFE8",marginBottom:16,fontSize:13,color:eligible?(r.simulated?"#9a5314":"#085041"):"#5F5E5A"}}>
        {eligible
          ? (r.simulated ? "✓ Simulation: läuft im Dashboard als Was-wäre-wenn mit." : "✓ Diese Runde wird HCP-wirksam eingehen.")
          : "✗ Diese Runde ist nicht HCP-wirksam."}
        {!r.submitted&&" → Runde einreichen."}
        {r.submitted&&!r.markerSigned&&" → Marker-Unterschrift fehlt."}
        {r.submitted&&r.markerSigned&&r.format!=="Einzel"&&" → Nur Einzel ist HCP-wirksam."}
        {parseInt(r.holes)===9&&!r.nineHoleAllowed&&" → Checkbox '9-Loch HCP-wirksam' aktivieren."}
      </div>
      {preview && (
        <div style={{...subtleCardStyle,padding:"14px 16px",marginBottom:16,border:"1px solid rgba(197,107,26,0.26)",background:"linear-gradient(180deg, #fff9f2 0%, #fff1df 100%)"}}>
          <div style={{fontSize:12,fontWeight:700,letterSpacing:"0.08em",textTransform:"uppercase",color:"#9a5314",marginBottom:8}}>Vorschau</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:10}}>
            <div><div style={{fontSize:12,color:"var(--color-text-secondary)"}}>Differenzial</div><div style={{fontSize:22,fontWeight:600}}>{preview.diff.toFixed(1)}</div></div>
            <div><div style={{fontSize:12,color:"var(--color-text-secondary)"}}>HCP danach</div><div style={{fontSize:22,fontWeight:600,color:COLORS.hcp}}>{preview.nextHcp.toFixed(1)}</div></div>
            <div><div style={{fontSize:12,color:"var(--color-text-secondary)"}}>Zählt?</div><div style={{fontSize:16,fontWeight:600,color:preview.wouldCount ? "#085041" : "#9a5314"}}>{preview.wouldCount ? "Ja" : "Eher nicht"}</div></div>
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
        <button onClick={handleSave} style={{padding:"9px 18px",borderRadius:"var(--border-radius-md)",background:r.simulated?"#C56B1A":COLORS.hcp,color:"#fff",border:"none",cursor:"pointer",fontWeight:500,fontSize:14}}>{r.simulated?"Simulation speichern":"Speichern"}</button>
        <button onClick={onCancel} style={{padding:"9px 18px",borderRadius:"var(--border-radius-md)",background:"transparent",border:"0.5px solid var(--color-border-tertiary)",cursor:"pointer",fontSize:14,color:"var(--color-text-primary)"}}>Abbrechen</button>
      </div>
    </div>
  );
}

// Scorekarte eines Platzes: Par und Vorgabenverteilung (Stroke Index) je Loch.
// Wird nur für Netto-Spiele in der Games-Rubrik gebraucht, deshalb standardmäßig
// eingeklappt. Die App schlägt eine Verteilung vor, korrigiert wird nach der
// echten Scorekarte.
function HoleDataEditor({holeCount, holeData, coursePar, onChange, onHoleCountChange}) {
  const holes = holeData ?? [];
  const parSum = totalPar(holes);
  const duplicateSi = useMemo(()=>{
    const seen = new Set();
    return holes.some(hole=>{
      if (seen.has(hole.si)) return true;
      seen.add(hole.si);
      return false;
    });
  }, [holes]);

  const setHole = (index, key, value) => {
    onChange(holes.map((hole, i)=>i===index ? {...hole, [key]: value} : hole));
  };

  const cell: CSSProperties = {...inp, padding:"6px 8px", fontSize:13, textAlign:"center"};

  return (
    <div>
      <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginBottom:12}}>
        <select style={{...sel,width:"auto"}} value={holeCount} onChange={e=>onHoleCountChange(parseInt(e.target.value))}>
          <option value={18}>18 Loch</option>
          <option value={9}>9 Loch</option>
        </select>
        <button type="button" onClick={()=>onChange(suggestHoles(holeCount, coursePar))}
          style={{padding:"9px 14px",borderRadius:"var(--border-radius-md)",border:"1px solid var(--color-border-secondary)",background:"rgba(255,255,255,0.92)",cursor:"pointer",fontSize:13,fontWeight:600,color:"var(--color-text-primary)"}}>
          Vorschlag neu erzeugen
        </button>
        <span style={{fontSize:12,color:COLORS.textSec,marginLeft:"auto"}}>Gesamt-Par {parSum}</span>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(150px, 1fr))",gap:10}}>
        {[0,9].filter(offset=>offset<holes.length).map(offset=>(
          <div key={offset}>
            <div style={{display:"grid",gridTemplateColumns:"28px 1fr 1fr",gap:6,fontSize:11,color:COLORS.textSec,fontWeight:600,marginBottom:4,textTransform:"uppercase",letterSpacing:"0.06em"}}>
              <span>Loch</span><span style={{textAlign:"center"}}>Par</span><span style={{textAlign:"center"}}>SI</span>
            </div>
            {holes.slice(offset, offset+9).map((hole, i)=>{
              const index = offset + i;
              return (
                <div key={hole.nr} style={{display:"grid",gridTemplateColumns:"28px 1fr 1fr",gap:6,marginBottom:5,alignItems:"center"}}>
                  <span style={{fontSize:13,fontWeight:600,color:"var(--color-text-secondary)"}}>{hole.nr}</span>
                  <input type="number" min={3} max={6} style={cell} value={hole.par}
                    onChange={e=>setHole(index,"par",parseInt(e.target.value)||hole.par)}/>
                  <input type="number" min={1} max={holes.length} style={cell} value={hole.si}
                    onChange={e=>setHole(index,"si",parseInt(e.target.value)||hole.si)}/>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {duplicateSi && (
        <div style={{marginTop:10,padding:"8px 12px",borderRadius:"var(--border-radius-md)",background:"#FDF1E6",color:"#9a5314",fontSize:12}}>
          Stroke Index doppelt vergeben. Jeder Wert von 1 bis {holes.length} darf nur einmal vorkommen – sonst wird die Verteilung beim Speichern automatisch korrigiert.
        </div>
      )}
    </div>
  );
}

function CourseForm({initial, rounds, startHcp, onSave, onCancel}) {
  const [c, setC] = useState(normalizeCourse(initial));
  const [showHoles, setShowHoles] = useState(Boolean(initial?.holeData?.length));
  const set = (k,v) => setC(prev=>({...prev,[k]:v}));
  const learnedFactor = useMemo(()=>deriveNineHolePhcpFactor(rounds, startHcp, c.id), [rounds, startHcp, c.id]);

  const holeCount = c.holeCount ?? 18;
  const openHoleEditor = () => {
    setShowHoles(true);
    if (!c.holeData?.length) setC(prev=>({...prev, holeCount, holeData: suggestHoles(holeCount, prev.par)}));
  };
  const changeHoleCount = count => setC(prev=>({...prev, holeCount: count, holeData: suggestHoles(count, prev.par)}));

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
      {showHoles
        ? field("Scorekarte (für Games)", <HoleDataEditor
            holeCount={holeCount}
            holeData={c.holeData}
            coursePar={c.par}
            onChange={data=>set("holeData", data)}
            onHoleCountChange={changeHoleCount}
          />, "Vorschlag – bitte an die echte Scorekarte anpassen")
        : field("Scorekarte (für Games)", <button type="button" onClick={openHoleEditor}
            style={{padding:"9px 14px",borderRadius:"var(--border-radius-md)",border:"1px solid var(--color-border-secondary)",background:"rgba(255,255,255,0.92)",cursor:"pointer",fontSize:13,fontWeight:600,color:"var(--color-text-primary)"}}>
            Par und Vorgabenverteilung erfassen
          </button>, "Nur für Netto-Spiele in der Games-Rubrik nötig")}
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

  const hasSimulated = rounds.some(r=>r.simulated);

  const filtered = rounds.filter(r=>{
    if (filter==="hcp") return isHcpEligible(r);
    if (filter==="no_hcp") return !isHcpEligible(r);
    if (filter==="counting") return countingIds.has(r.id);
    if (filter==="simulated") return Boolean(r.simulated);
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
          {[["all","Alle"],["hcp","HCP-wirksam"],["counting",`Zählt aktuell (${take})`],["no_hcp","Nicht wirksam"],...(hasSimulated?[["simulated","Simulation"]]:[])].map(([v,l])=>(
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

/** Zeichnet einen QR-Code als SVG – scharf in jeder Groesse, ohne Canvas. */
function QrCode({text, size=200}) {
  const path = useMemo(()=>{
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const parts: string[] = [];
    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) {
        if (qr.isDark(row, col)) parts.push(`M${col} ${row}h1v1h-1z`);
      }
    }
    return {d: parts.join(""), count};
  },[text]);

  return (
    <svg
      viewBox={`-1 -1 ${path.count + 2} ${path.count + 2}`}
      width={size}
      height={size}
      role="img"
      aria-label="QR-Code zum Scannen mit der Kamera"
      style={{display:"block",background:"#fff",borderRadius:12,padding:0}}
    >
      <rect x={-1} y={-1} width={path.count + 2} height={path.count + 2} fill="#fff"/>
      <path d={path.d} fill="#111"/>
    </svg>
  );
}

/**
 * Karte zum Weitergeben: QR-Code plus Link zum Kopieren. Gescannt wird mit der
 * Kamera-App des Telefons – die oeffnet den Link, und die App bietet die
 * Uebernahme an. Deshalb braucht es hier keinen eingebauten Scanner.
 */
function ShareCardPanel({card, hint}) {
  const [copied, setCopied] = useState(false);
  const url = useMemo(()=>buildShareUrl(card, typeof window!=="undefined" ? window.location.origin : LEGAL.site.url),[card]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(()=>setCopied(false), 2000);
    } catch(e) { /* Zwischenablage nicht erlaubt: Der Link steht ja lesbar da. */ }
  };

  return (
    <div style={{display:"flex",gap:18,flexWrap:"wrap",alignItems:"flex-start"}}>
      <div style={{flexShrink:0,padding:10,borderRadius:16,background:"#fff",border:"1px solid var(--color-border-tertiary)",boxShadow:"var(--shadow-soft)"}}>
        <QrCode text={url} size={186}/>
      </div>
      <div style={{flex:"1 1 220px",minWidth:0}}>
        <div style={{fontSize:14,lineHeight:1.6,color:"var(--color-text-secondary)",marginBottom:12}}>{hint}</div>
        <div style={{fontSize:12,fontFamily:"monospace",wordBreak:"break-all",color:"var(--color-text-secondary)",background:"var(--color-background-secondary)",borderRadius:"var(--border-radius-md)",padding:"8px 10px",marginBottom:10,maxHeight:76,overflow:"auto"}}>
          {url}
        </div>
        <button type="button" onClick={copy} style={{padding:"8px 14px",borderRadius:"var(--border-radius-md)",border:"0.5px solid var(--color-border-secondary)",background:"#F5F4F0",cursor:"pointer",fontSize:13,fontWeight:600,color:"var(--color-text-primary)",fontFamily:"var(--font-sans)"}}>
          {copied ? "Link kopiert" : "Link kopieren"}
        </button>
      </div>
    </div>
  );
}


const CAMERA_HINTS: Record<CameraFailure, string> = {
  denied: "Die Kamera ist blockiert. Du kannst sie in den Browser-Einstellungen für diese Seite freigeben – oder den Link unten einfügen.",
  notfound: "Keine Kamera gefunden. Nimm den Weg über den Link.",
  unsupported: "Dieser Browser gibt die Kamera nicht frei. Nimm den Weg über den Link.",
  error: "Die Kamera lässt sich gerade nicht öffnen. Nimm den Weg über den Link.",
};

/**
 * Scannt eine geteilte Karte mit der Kamera. Der Weg ueber den eingefuegten Link
 * steht immer daneben – nicht nur als Notnagel bei verweigerter Kamera, sondern
 * auch fuer alle, die den Code lieber per Nachricht schicken.
 */
function QrScanDialog({title, hint, onDetect, onClose, accepts}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [failure, setFailure] = useState<CameraFailure | null>(isCameraSupported() ? null : "unsupported");
  const [manual, setManual] = useState("");
  const [problem, setProblem] = useState("");

  const handleCard = card => {
    if (!card) { setProblem("Darin steckt keine Karte von Wolf Golf."); return false; }
    if (accepts && !accepts.includes(card.kind)) {
      setProblem(card.kind === "game"
        ? "Das ist eine Spielkarte – die öffnest du über den Link, sie legt ein eigenes Spiel an."
        : "Diese Karte passt hier nicht.");
      return false;
    }
    setProblem("");
    onDetect(card);
    return true;
  };

  useEffect(()=>{
    if (failure) return;
    let stream: MediaStream | null = null;
    let timer = 0;
    let stopped = false;

    (async ()=>{
      try {
        stream = await startCamera();
        if (stopped) { stopCamera(stream); return; }
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          video.setAttribute("playsinline", "true");
          await video.play().catch(()=>undefined);
        }
        const detect = await createDetector();
        const tick = async () => {
          if (stopped) return;
          const canvas = canvasRef.current;
          if (video && canvas && drawFrame(video, canvas)) {
            try {
              const value = await detect(canvas);
              if (value && handleCard(parseShareLink(value))) return;
            } catch(e) { /* Einzelbild unlesbar: naechster Versuch. */ }
          }
          timer = window.setTimeout(tick, 250);
        };
        tick();
      } catch(error) {
        if (!stopped) setFailure(classifyCameraError(error));
      }
    })();

    return ()=>{
      stopped = true;
      window.clearTimeout(timer);
      stopCamera(stream);
    };
  },[failure]);

  return (
    <Modal title={title} onClose={onClose} maxWidth={520}>
      <div style={{fontSize:14,lineHeight:1.6,color:"var(--color-text-secondary)",marginBottom:12}}>{hint}</div>

      {failure ? (
        <div style={{...subtleCardStyle,padding:"14px 16px",marginBottom:14,background:"linear-gradient(180deg, rgba(255,247,233,0.98) 0%, rgba(255,251,243,0.96) 100%)",border:"1px solid rgba(190,120,20,0.28)",fontSize:13,lineHeight:1.6,color:"#6B4310"}}>
          {CAMERA_HINTS[failure]}
        </div>
      ) : (
        <div style={{position:"relative",borderRadius:"var(--border-radius-md)",overflow:"hidden",background:"#111",marginBottom:14,aspectRatio:"4 / 3"}}>
          <video ref={videoRef} muted playsInline style={{width:"100%",height:"100%",objectFit:"cover",display:"block"}}/>
          <div aria-hidden="true" style={{position:"absolute",inset:"12%",border:"3px solid rgba(255,255,255,0.85)",borderRadius:16,boxShadow:"0 0 0 9999px rgba(0,0,0,0.28)"}}/>
        </div>
      )}
      <canvas ref={canvasRef} style={{display:"none"}}/>

      <div style={{borderTop:"1px solid var(--color-border-tertiary)",paddingTop:14}}>
        <div style={{fontSize:13,fontWeight:600,marginBottom:6}}>Oder Link einfügen</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:8}}>
          <input
            style={inp}
            value={manual}
            onChange={e=>{ setManual(e.target.value); setProblem(""); }}
            placeholder="https://wolfgolf.club/#p=…"
          />
          <button type="button" onClick={()=>handleCard(parseShareLink(manual))} style={{...gamesGhostBtn,padding:"10px 14px"}}>Lesen</button>
        </div>
        {problem && <div style={{fontSize:13,color:"#E24B4A",marginTop:8}}>{problem}</div>}
      </div>
    </Modal>
  );
}

function CourseList({courses, onNew, onEdit}) {
  const [shared, setShared] = useState(null);
  const sharedCard = useMemo(()=>{
    if (!shared) return null;
    return {
      kind: "course",
      name: shared.name,
      courseRating: parseFloat(shared.courseRating),
      slopeRating: parseFloat(shared.slopeRating),
      par: parseInt(shared.par, 10),
      tee: shared.tee,
      holeCount: shared.holeCount,
      holeData: Array.isArray(shared.holeData) ? shared.holeData.map(hole=>({par:hole.par, si:hole.si})) : undefined,
    } as ShareCard;
  },[shared]);

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
          <div style={{display:"flex",gap:8}}>
            <button onClick={()=>setShared(c)} style={{padding:"4px 10px",borderRadius:"var(--border-radius-md)",border:"0.5px solid var(--color-border-tertiary)",background:"transparent",cursor:"pointer",fontSize:12,color:"var(--color-text-primary)"}}>Teilen</button>
            <button onClick={()=>onEdit(c)} style={{padding:"4px 10px",borderRadius:"var(--border-radius-md)",border:"0.5px solid var(--color-border-tertiary)",background:"transparent",cursor:"pointer",fontSize:12,color:"var(--color-text-primary)"}}>Bearbeiten</button>
          </div>
        </div>
      ))}

      {sharedCard && (
        <Modal title="Platzkarte teilen" onClose={()=>setShared(null)} maxWidth={620}>
          <ShareCardPanel
            card={sharedCard}
            hint={shared.holeData?.length
              ? "Mitspieler scannen den Code mit der Kamera ihres Telefons. Sie bekommen Course Rating, Slope, Par und die komplette Scorekarte mit Vorgabenverteilung – ohne etwas abzutippen."
              : "Mitspieler scannen den Code mit der Kamera ihres Telefons und bekommen Course Rating, Slope und Par. Für die Vorgabenverteilung je Loch trage die Scorekarte unter „Bearbeiten“ ein – sie wird dann mitgeteilt."}
          />
        </Modal>
      )}
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

// ---------------------------------------------------------------------------
// Games: Spiele gegeneinander (Matchplay, Skins). Loch für Loch erfasst, alle
// aktivierten Formate laufen auf denselben Scores parallel mit.
// ---------------------------------------------------------------------------

const GAME_FORMATS = [
  {id:"matchplay", label:"Matchplay", hint:"1 gegen 1, Loch für Loch"},
  {id:"nassau", label:"Nassau", hint:"Front 9, Back 9 und Gesamt als drei Wetten, Press per Knopf"},
  {id:"skins", label:"Skins", hint:"Jedes Loch ein Topf, Carry-over bei Gleichstand"},
  {id:"wolf", label:"Wolf", hint:"Rotierender Wolf wählt Partner oder geht allein (3 bis 5 Spieler)"},
  {id:"bbb", label:"Bingo Bango Bongo", hint:"Drei Punkte pro Loch, direkt im Loch-Screen angetippt"},
];

/** Spielformate, die genau zwei Kontrahenten brauchen. */
const DUEL_FORMATS = ["matchplay", "nassau"];

const HANDICAP_MODES = [
  {id:"difference", label:"Netto – Differenz zum Besten", hint:"Lochspiel-Standard: der beste Spieler spielt Scratch"},
  {id:"full", label:"Netto – volles Course Handicap", hint:"Jeder bekommt seine kompletten Vorgabenschläge"},
  {id:"gross", label:"Brutto – ohne Vorgabe", hint:"Reine Schlagzahl, keine Vorgabenschläge"},
];

const gamesPrimaryBtn: CSSProperties = {padding:"10px 18px",borderRadius:"var(--border-radius-md)",background:COLORS.hcp,color:"#fff",border:"none",cursor:"pointer",fontWeight:600,fontSize:14};
const gamesGhostBtn: CSSProperties = {padding:"10px 18px",borderRadius:"var(--border-radius-md)",background:"transparent",border:"0.5px solid var(--color-border-tertiary)",cursor:"pointer",fontSize:14,color:"var(--color-text-primary)"};

// Die App zaehlt ausschliesslich Punkte. Was ein Punkt wert ist, vereinbart der
// Flight unter sich – so kommen keine Geldbetraege in die App.
function formatStake(amount) {
  const value = Math.round((amount || 0) * 100) / 100;
  return `${String(value).replace(".", ",")} Pkt`;
}

function formatSignedStake(amount) {
  const value = Math.round((amount || 0) * 100) / 100;
  if (value === 0) return formatStake(0);
  return `${value > 0 ? "+" : "−"}${formatStake(Math.abs(value))}`;
}

/** Course Handicap eines Spielers für dieses Spiel (inkl. 9-Loch-Faktor). */
function gameCourseHandicap(hcpIndex, course, holeCount) {
  const value = calcPlayingHcpFromCourse(hcpIndex, course, holeCount);
  return value === null ? 0 : value;
}

/**
 * Verrechnet die Salden zu möglichst wenigen Ausgleichen ("wer gibt wem").
 * Die App kennt nur Punkte; was ein Punkt wert ist, klaeren die Spieler selbst.
 * Erwartet eine Liste, deren Beträge sich zu 0 aufheben.
 */
function buildSettlement(balances) {
  const debtors = balances.filter(b=>b.amount < -0.005).map(b=>({...b, rest:-b.amount})).sort((a,b)=>b.rest-a.rest);
  const creditors = balances.filter(b=>b.amount > 0.005).map(b=>({...b, rest:b.amount})).sort((a,b)=>b.rest-a.rest);
  const transfers = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].rest, creditors[j].rest);
    if (amount > 0.005) transfers.push({from:debtors[i].name, to:creditors[j].name, amount});
    debtors[i].rest -= amount;
    creditors[j].rest -= amount;
    if (debtors[i].rest <= 0.005) i += 1;
    if (creditors[j].rest <= 0.005) j += 1;
  }
  return transfers;
}

/** Alle abgeleiteten Werte eines Spiels an einer Stelle. */
function useGameState(game) {
  return useMemo(()=>{
    const ids = game.participants.map(p=>p.playerId);
    const nameById = new Map(game.participants.map(p=>[p.playerId, p.name]));
    const allocations = buildAllocations(
      game.participants.map(p=>({id:p.playerId, courseHandicap:p.courseHandicap})),
      game.holes,
      game.handicap,
    );
    const allocationById = new Map(allocations.map(a=>[a.id, a]));

    const hasDuel = Array.isArray(game.matchup) && game.matchup.length === 2;
    const matchplay = hasDuel && game.formats.includes("matchplay")
      ? scoreMatchplay(game.matchup[0], game.matchup[1], game.scores, allocations, game.holes)
      : null;
    const nassau = hasDuel && game.formats.includes("nassau")
      ? scoreNassau(game.matchup[0], game.matchup[1], game.scores, allocations, game.holes, game.nassauPresses)
      : null;
    const skins = game.formats.includes("skins")
      ? scoreSkins(ids, game.scores, allocations, game.holes)
      : null;
    const wolf = game.formats.includes("wolf") && ids.length >= 3
      ? scoreWolf(ids, game.scores, allocations, game.holes, game.wolfChoices)
      : null;
    const bbb = game.formats.includes("bbb")
      ? scoreBingoBangoBongo(ids, game.bbbAwards, game.holeCount)
      : null;

    const played = playedHoleCount(game.scores, ids, game.holeCount);

    // Salden je Spieler: Matchplay zwischen den beiden Kontrahenten, Skins über
    // den ganzen Flight (jeder Skin wird von allen anderen bezahlt).
    const balances = new Map<string, number>(ids.map(id=>[id, 0]));
    if (matchplay && matchplay.complete && matchplay.winner) {
      const [a, b] = game.matchup;
      const winnerId = matchplay.winner === "a" ? a : b;
      const loserId = matchplay.winner === "a" ? b : a;
      balances.set(winnerId, balances.get(winnerId) + game.stake.match);
      balances.set(loserId, balances.get(loserId) - game.stake.match);
    }
    if (nassau) {
      const [a, b] = game.matchup;
      const delta = (nassau.totals.a - nassau.totals.b) * game.stake.nassau;
      balances.set(a, balances.get(a) + delta);
      balances.set(b, balances.get(b) - delta);
    }
    // Punktespiele werden über den Abstand zum Feld verrechnet: wer einen Punkt
    // holt, bekommt ihn von jedem anderen. Das bleibt in Summe bei null.
    const settlePoints = (totals, stake)=>{
      if (ids.length < 2) return;
      const sum = ids.reduce((total, id)=>total + (totals[id] || 0), 0);
      for (const id of ids) {
        balances.set(id, balances.get(id) + stake * (ids.length * (totals[id] || 0) - sum));
      }
    };
    if (skins) settlePoints(skins.totals, game.stake.skin);
    if (wolf) settlePoints(wolf.totals, game.stake.point);
    if (bbb) settlePoints(bbb.totals, game.stake.point);

    const balanceList = ids.map(id=>({id, name:nameById.get(id) || id, amount:balances.get(id) || 0}));

    return {ids, nameById, allocations, allocationById, matchplay, nassau, skins, wolf, bbb, played, balanceList};
  }, [game]);
}

/** Große Tippflächen für die Schlageingabe – mit Handschuh bedienbar. */
function ScoreStepper({value, par, onChange}) {
  const has = Number.isFinite(value);
  const step = delta => {
    if (!has) return onChange(par);
    onChange(Math.min(20, Math.max(1, value + delta)));
  };
  const btn: CSSProperties = {width:44,height:44,borderRadius:"var(--border-radius-md)",border:"1px solid var(--color-border-secondary)",background:"rgba(255,255,255,0.94)",fontSize:22,lineHeight:1,cursor:"pointer",color:"var(--color-text-primary)",fontWeight:600,flexShrink:0,touchAction:"manipulation"};
  return (
    <div style={{display:"flex",alignItems:"center",gap:8}}>
      <button type="button" aria-label="Schlag weniger" onClick={()=>step(-1)} style={btn}>−</button>
      <input
        type="number"
        inputMode="numeric"
        aria-label="Schläge"
        value={has ? value : ""}
        placeholder="–"
        onChange={e=>{
          const parsed = parseInt(e.target.value, 10);
          onChange(Number.isFinite(parsed) ? Math.min(20, Math.max(1, parsed)) : null);
        }}
        style={{...inp,width:56,padding:"10px 4px",textAlign:"center",fontSize:20,fontWeight:700,flexShrink:0}}
      />
      <button type="button" aria-label="Schlag mehr" onClick={()=>step(1)} style={btn}>+</button>
    </div>
  );
}

function StrokeDots({strokes}) {
  if (!strokes) return null;
  if (strokes < 0) return <span style={{fontSize:11,color:"#9a5314",fontWeight:700}}>{strokes}</span>;
  return <span style={{fontSize:13,color:COLORS.hcp,letterSpacing:1,fontWeight:700}}>{"•".repeat(Math.min(strokes, 4))}</span>;
}

function GameSetupForm({courses, players, profileName, displayHcp, onStart, onAddPlayer, onUpdatePlayer, onUpsertCourse, onCancel}) {
  const [date, setDate] = useState(()=>new Date().toISOString().slice(0,10));
  const [courseId, setCourseId] = useState(()=>courses[0]?.id ?? "");
  const [holeCount, setHoleCount] = useState(18);
  const [selectedIds, setSelectedIds] = useState(()=>players.filter(p=>p.isMe).map(p=>p.id));
  const [formats, setFormats] = useState(["matchplay"]);
  const [matchup, setMatchup] = useState([]);
  const [handicapMode, setHandicapMode] = useState<"difference"|"full"|"gross">(DEFAULT_HANDICAP_CONFIG.mode);
  const [handicapPercent, setHandicapPercent] = useState(DEFAULT_HANDICAP_CONFIG.percent);
  const [stakes, setStakes] = useState({skin:"1", match:"1", nassau:"1", point:"1"});
  const [newName, setNewName] = useState("");
  const [newHcp, setNewHcp] = useState("");
  const [scanning, setScanning] = useState(false);

  const course = courses.find(c=>c.id === parseInt(courseId));
  const holes = useMemo(
    ()=>normalizeHoles(course?.holeData, holeCount, course?.par),
    [course?.holeData, course?.par, holeCount],
  );
  const holeDataMissing = Boolean(course) && !course.holeData?.length;

  const selected = selectedIds.map(id=>players.find(p=>p.id === id)).filter(Boolean);
  const toggleSelected = id => setSelectedIds(prev=>{
    const next = prev.includes(id) ? prev.filter(x=>x !== id) : [...prev, id];
    setMatchup(m=>m.filter(x=>next.includes(parseInt(x))));
    return next;
  });
  const toggleFormat = id => setFormats(prev=>prev.includes(id) ? prev.filter(x=>x !== id) : [...prev, id]);

  const toggleMatchup = id => setMatchup(prev=>{
    const key = String(id);
    if (prev.includes(key)) return prev.filter(x=>x !== key);
    if (prev.length >= 2) return [prev[1], key];
    return [...prev, key];
  });

  // Bei genau zwei Teilnehmern ist die Paarung eindeutig.
  const effectiveMatchup = selected.length === 2 ? selected.map(p=>String(p.id)) : matchup;

  const handicapPreview = useMemo(()=>{
    if (!course || selected.length < 2) return [];
    const config = {mode:handicapMode, percent:handicapPercent};
    const participants = selected.map(p=>({
      id: String(p.id),
      courseHandicap: gameCourseHandicap(p.isMe ? displayHcp : p.hcpIndex, course, holeCount),
    }));
    const allocations = buildAllocations(participants, holes, config);
    return selected.map((player, index)=>({
      name: player.name,
      courseHandicap: allocations[index].courseHandicap,
      gameHandicap: allocations[index].gameHandicap,
    }));
  }, [course, selected, handicapMode, handicapPercent, holes, holeCount, displayHcp]);

  const needsDuel = formats.some(id=>DUEL_FORMATS.includes(id));
  const duelLabel = formats.filter(id=>DUEL_FORMATS.includes(id))
    .map(id=>GAME_FORMATS.find(format=>format.id === id)?.label).join(" / ");

  const problems = [];
  if (!course) problems.push("Bitte einen Platz wählen – Games brauchen Course Rating, Slope und die Scorekarte.");
  if (selected.length < 2) problems.push("Mindestens zwei Teilnehmer auswählen.");
  if (!formats.length) problems.push("Mindestens ein Spielformat aktivieren.");
  if (needsDuel && effectiveMatchup.length !== 2) problems.push(`Für ${duelLabel} genau zwei Kontrahenten markieren.`);
  if (formats.includes("wolf") && (selected.length < 3 || selected.length > 5)) problems.push("Wolf braucht drei bis fünf Teilnehmer.");

  const start = () => {
    if (problems.length) return;
    onStart({
      date,
      courseId: course.id,
      courseName: course.name,
      courseRating: course.courseRating,
      slopeRating: course.slopeRating,
      coursePar: course.par,
      holeCount,
      holes,
      handicap: {mode:handicapMode, percent:handicapPercent},
      formats,
      matchup: needsDuel ? effectiveMatchup : [],
      wolfChoices: Array.from({length:holeCount},()=>({partnerId:null, blind:false})),
      bbbAwards: Array.from({length:holeCount},()=>({bingo:null, bango:null, bongo:null})),
      nassauPresses: [],
      stake: {
        skin: parseFloat(stakes.skin) || 1,
        match: parseFloat(stakes.match) || 1,
        nassau: parseFloat(stakes.nassau) || 1,
        point: parseFloat(stakes.point) || 1,
      },
      participants: selected.map(player=>({
        playerId: String(player.id),
        name: player.isMe ? (player.name || profileName) : player.name,
        isMe: Boolean(player.isMe),
        hcpIndex: player.isMe ? displayHcp : player.hcpIndex,
        courseHandicap: gameCourseHandicap(player.isMe ? displayHcp : player.hcpIndex, course, holeCount),
      })),
    });
  };

  const takeScannedCard = card => {
    if (card.kind === "player") {
      const existing = players.find(p=>!p.isMe && p.name.toLowerCase() === card.name.toLowerCase());
      const id = existing ? existing.id : onAddPlayer({name: card.name, hcpIndex: card.hcpIndex});
      if (existing && existing.hcpIndex !== card.hcpIndex) onUpdatePlayer(existing.id, {hcpIndex: card.hcpIndex});
      setSelectedIds(prev=>prev.includes(id) ? prev : [...prev, id]);
    } else if (card.kind === "course") {
      const id = onUpsertCourse(card);
      setCourseId(String(id));
    }
    setScanning(false);
  };

  const addPlayer = () => {
    const name = newName.trim();
    if (!name) return;
    const hcpIndex = parseFloat(newHcp);
    const id = onAddPlayer({name, hcpIndex: Number.isFinite(hcpIndex) ? hcpIndex : 54});
    setSelectedIds(prev=>[...prev, id]);
    setNewName("");
    setNewHcp("");
  };

  return (
    <div>
      {field("Datum", <input type="date" style={inp} value={date} onChange={e=>setDate(e.target.value)}/>)}
      <div style={{display:"grid",gridTemplateColumns:"2fr 1fr",gap:10}}>
        {field("Platz", <select style={sel} value={courseId} onChange={e=>setCourseId(e.target.value)}>
          <option value="">– wählen –</option>
          {courses.map(c=><option key={c.id} value={c.id}>{c.name} (CR {c.courseRating} / SR {c.slopeRating})</option>)}
        </select>)}
        {field("Löcher", <select style={sel} value={holeCount} onChange={e=>setHoleCount(parseInt(e.target.value))}>
          <option value={18}>18 Loch</option>
          <option value={9}>9 Loch</option>
        </select>)}
      </div>
      {holeDataMissing && (
        <div style={{marginBottom:14,padding:"10px 14px",borderRadius:"var(--border-radius-md)",background:"#FDF1E6",color:"#9a5314",fontSize:12.5}}>
          Für „{course.name}" ist noch keine Scorekarte hinterlegt. Das Spiel startet mit der vorgeschlagenen Vorgabenverteilung – die echte Verteilung kannst du unter Plätze eintragen.
        </div>
      )}

      {field("Teilnehmer", <div>
        <div style={{display:"flex",flexWrap:"wrap",gap:8,marginBottom:10}}>
          {players.map(player=>{
            const active = selectedIds.includes(player.id);
            return (
              <button key={player.id} type="button" onClick={()=>toggleSelected(player.id)}
                style={{padding:"8px 14px",borderRadius:"999px",border:`1px solid ${active?"transparent":"var(--color-border-secondary)"}`,background:active?"linear-gradient(135deg, #1D9E75 0%, #14684f 100%)":"rgba(255,255,255,0.9)",color:active?"#fff":"var(--color-text-primary)",cursor:"pointer",fontSize:13,fontWeight:active?600:500}}>
                {player.isMe ? `${player.name || profileName} (du)` : player.name} · {player.isMe ? displayHcp : player.hcpIndex}
              </button>
            );
          })}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 90px auto",gap:8}}>
          <input style={inp} value={newName} onChange={e=>setNewName(e.target.value)} placeholder="Mitspieler hinzufügen"/>
          <input type="number" step="0.1" style={inp} value={newHcp} onChange={e=>setNewHcp(e.target.value)} placeholder="HCP"/>
          <button type="button" onClick={addPlayer} style={{...gamesGhostBtn,padding:"10px 14px"}}>+</button>
          <button type="button" onClick={()=>setScanning(true)} style={{...gamesGhostBtn,padding:"10px 14px",gridColumn:"1 / -1"}}>Spielerkarte scannen</button>
        </div>
      </div>, "Mitspieler bleiben für die nächsten Spiele gespeichert")}

      {scanning && (
        <QrScanDialog
          title="Karte scannen"
          hint="Halte die Kamera auf die Spielerkarte deines Mitspielers – oder auf eine Platzkarte. Der Gescannte wird direkt für dieses Spiel ausgewählt, deine bisherigen Eingaben bleiben erhalten."
          accepts={["player", "course"]}
          onDetect={takeScannedCard}
          onClose={()=>setScanning(false)}
        />
      )}

      {field("Spielformate", <div style={{display:"flex",flexDirection:"column",gap:8}}>
        {GAME_FORMATS.map(format=>(
          <label key={format.id} style={{display:"flex",alignItems:"flex-start",gap:10,cursor:"pointer",padding:"10px 12px",borderRadius:"var(--border-radius-md)",border:`1px solid ${formats.includes(format.id)?"rgba(29,158,117,0.4)":"var(--color-border-tertiary)"}`,background:formats.includes(format.id)?"#ecfbf4":"rgba(255,255,255,0.9)"}}>
            <input type="checkbox" checked={formats.includes(format.id)} onChange={()=>toggleFormat(format.id)} style={{marginTop:2}}/>
            <span>
              <span style={{fontSize:14,fontWeight:600,display:"block"}}>{format.label}</span>
              <span style={{fontSize:12,color:COLORS.textSec}}>{format.hint}</span>
            </span>
          </label>
        ))}
      </div>, "Mehrere Formate laufen parallel auf denselben Scores")}

      {needsDuel && selected.length > 2 && field(`Paarung (${duelLabel})`, <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
        {selected.map(player=>{
          const active = matchup.includes(String(player.id));
          return (
            <button key={player.id} type="button" onClick={()=>toggleMatchup(player.id)}
              style={{padding:"8px 14px",borderRadius:"999px",border:`1px solid ${active?"transparent":"var(--color-border-secondary)"}`,background:active?"#378ADD":"rgba(255,255,255,0.9)",color:active?"#fff":"var(--color-text-primary)",cursor:"pointer",fontSize:13,fontWeight:active?600:500}}>
              {player.name}
            </button>
          );
        })}
      </div>, "Genau zwei Spieler markieren")}

      <div style={{display:"grid",gridTemplateColumns:"2fr 1fr",gap:10}}>
        {field("Vorgabe", <select style={sel} value={handicapMode} onChange={e=>setHandicapMode(e.target.value as "difference"|"full"|"gross")}>
          {HANDICAP_MODES.map(mode=><option key={mode.id} value={mode.id}>{mode.label}</option>)}
        </select>, HANDICAP_MODES.find(m=>m.id === handicapMode)?.hint)}
        {field("Anteil", <input type="number" step="5" min="0" max="100" style={{...inp,opacity:handicapMode === "gross" ? 0.5 : 1}} disabled={handicapMode === "gross"} value={handicapPercent} onChange={e=>setHandicapPercent(parseFloat(e.target.value))}/>, "% der Vorgabe")}
      </div>

      {handicapPreview.length > 0 && (
        <div style={{...subtleCardStyle,padding:"12px 14px",marginBottom:14}}>
          <div style={{fontSize:11,fontWeight:700,letterSpacing:"0.08em",textTransform:"uppercase",color:COLORS.textSec,marginBottom:8}}>Vorgabenschläge in diesem Spiel</div>
          {handicapPreview.map(entry=>(
            <div key={entry.name} style={{display:"flex",justifyContent:"space-between",fontSize:13,padding:"3px 0"}}>
              <span>{entry.name}</span>
              <span style={{color:COLORS.textSec}}>CH {entry.courseHandicap} → <strong style={{color:"var(--color-text-primary)"}}>{entry.gameHandicap}</strong></span>
            </div>
          ))}
        </div>
      )}

      <div style={{fontSize:12,color:"var(--color-text-secondary)",lineHeight:1.55,marginBottom:8}}>
        <strong style={{color:"var(--color-text-primary)",fontWeight:600}}>Einsatz in Punkten.</strong>{" "}
        Was ein Punkt wert ist, vereinbart der Flight unter sich – die App zählt nur Punkte und rechnet nichts in Geld um.
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(110px, 1fr))",gap:10}}>
        {[
          {key:"match", label:"je Matchplay", active:formats.includes("matchplay")},
          {key:"nassau", label:"je Nassau-Wette", active:formats.includes("nassau")},
          {key:"skin", label:"je Skin", active:formats.includes("skins")},
          {key:"point", label:"je Spielpunkt", active:formats.includes("wolf") || formats.includes("bbb")},
        ].filter(entry=>entry.active).map(entry=>(
          <div key={entry.key}>{field(entry.label, <input type="number" step="0.5" min="0" style={inp}
            value={stakes[entry.key]} onChange={e=>setStakes(prev=>({...prev,[entry.key]:e.target.value}))}/>)}</div>
        ))}
      </div>

      {problems.length > 0 && (
        <div style={{marginBottom:14,padding:"10px 14px",borderRadius:"var(--border-radius-md)",background:"#F1EFE8",color:"#5F5E5A",fontSize:12.5}}>
          {problems.map(problem=><div key={problem}>· {problem}</div>)}
        </div>
      )}

      <div style={{display:"flex",gap:8}}>
        <button onClick={start} disabled={problems.length > 0} style={{...gamesPrimaryBtn,opacity:problems.length?0.5:1,cursor:problems.length?"not-allowed":"pointer"}}>Spiel starten</button>
        <button onClick={onCancel} style={gamesGhostBtn}>Abbrechen</button>
      </div>
    </div>
  );
}

/** Punktetabelle, absteigend sortiert – für Skins, Wolf und BBB. */
function PointsPanel({title, ids, nameById, totals, note=null, children=null}) {
  return (
    <div style={{...subtleCardStyle,padding:"12px 14px"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",gap:10,marginBottom:6}}>
        <span style={{fontSize:11,fontWeight:700,letterSpacing:"0.08em",textTransform:"uppercase",color:COLORS.textSec}}>{title}</span>
        {note}
      </div>
      {[...ids].sort((a,b)=>(totals[b] || 0) - (totals[a] || 0)).map(id=>(
        <div key={id} style={{display:"flex",justifyContent:"space-between",fontSize:13,padding:"3px 0"}}>
          <span>{nameById.get(id)}</span>
          <strong>{totals[id] || 0}</strong>
        </div>
      ))}
      {children}
    </div>
  );
}

function GameStandings({game, state, compact=false}) {
  const {matchplay, nassau, skins, wolf, bbb, nameById, ids} = state;
  return (
    <div style={{display:"grid",gap:10}}>
      {matchplay && (()=>{
        const [a, b] = game.matchup;
        const leaderName = matchplay.status === 0 ? null : nameById.get(matchplay.status > 0 ? a : b);
        return (
          <div style={{...subtleCardStyle,padding:"12px 14px"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",gap:10}}>
              <span style={{fontSize:11,fontWeight:700,letterSpacing:"0.08em",textTransform:"uppercase",color:COLORS.textSec}}>Matchplay</span>
              <span style={{fontSize:12,color:COLORS.textSec}}>{nameById.get(a)} vs. {nameById.get(b)}</span>
            </div>
            <div style={{fontSize:22,fontWeight:700,marginTop:4,color:matchplay.status === 0 ? "var(--color-text-primary)" : COLORS.hcp}}>
              {matchplay.resultLabel ?? matchplay.statusLabel}
              {leaderName && !matchplay.resultLabel ? <span style={{fontSize:14,fontWeight:500,color:COLORS.textSec}}> für {leaderName}</span> : null}
              {matchplay.resultLabel && matchplay.winner ? <span style={{fontSize:14,fontWeight:500,color:COLORS.textSec}}> für {nameById.get(matchplay.winner === "a" ? a : b)}</span> : null}
            </div>
            {!compact && (
              <div style={{fontSize:12,color:COLORS.textSec,marginTop:2}}>
                {matchplay.decided
                  ? `entschieden nach Loch ${(matchplay.decidedAtHole ?? 0) + 1}`
                  : `${matchplay.playedHoles} gespielt · ${matchplay.remainingHoles} offen`}
              </div>
            )}
          </div>
        );
      })()}

      {nassau && (()=>{
        const [a, b] = game.matchup;
        return (
          <div style={{...subtleCardStyle,padding:"12px 14px"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",gap:10,marginBottom:6}}>
              <span style={{fontSize:11,fontWeight:700,letterSpacing:"0.08em",textTransform:"uppercase",color:COLORS.textSec}}>Nassau</span>
              <span style={{fontSize:12,color:COLORS.textSec}}>{nameById.get(a)} {nassau.totals.a}:{nassau.totals.b} {nameById.get(b)}</span>
            </div>
            {nassau.bets.map(bet=>(
              <div key={bet.key} style={{display:"flex",justifyContent:"space-between",fontSize:13,padding:"3px 0",gap:10}}>
                <span style={{color:bet.press?"#9a5314":"var(--color-text-primary)"}}>{bet.label}</span>
                <strong style={{whiteSpace:"nowrap"}}>
                  {bet.result.resultLabel ?? bet.result.statusLabel}
                  {bet.result.status !== 0 && <span style={{fontWeight:500,color:COLORS.textSec}}> {nameById.get(bet.result.status > 0 ? a : b)}</span>}
                </strong>
              </div>
            ))}
          </div>
        );
      })()}

      {skins && <PointsPanel title="Skins" ids={ids} nameById={nameById} totals={skins.totals}
        note={skins.openCarry > 0 ? <span style={{fontSize:12,color:"#9a5314",fontWeight:600}}>{skins.openCarry} im Topf</span> : null}/>}

      {wolf && <PointsPanel title="Wolf" ids={ids} nameById={nameById} totals={wolf.totals}/>}

      {bbb && <PointsPanel title="Bingo Bango Bongo" ids={ids} nameById={nameById} totals={bbb.totals}>
        {!compact && (
          <div style={{fontSize:11,color:COLORS.textSec,marginTop:8}}>
            {ids.map(id=>`${nameById.get(id)}: ${bbb.byAward[id].bingo}/${bbb.byAward[id].bango}/${bbb.byAward[id].bongo}`).join(" · ")}
            <div style={{marginTop:2}}>Bingo / Bango / Bongo</div>
          </div>
        )}
      </PointsPanel>}
    </div>
  );
}

/** Auswahlreihe aus Spieler-Chips – für Wolf-Partner und Bingo Bango Bongo. */
function PlayerChips({participants, value, onSelect, extra=null, accent=COLORS.hcp}) {
  return (
    <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
      {participants.map(participant=>{
        const active = value === participant.playerId;
        return (
          <button key={participant.playerId} type="button"
            onClick={()=>onSelect(active ? null : participant.playerId)}
            style={{padding:"7px 12px",borderRadius:"999px",border:`1px solid ${active?"transparent":"var(--color-border-secondary)"}`,background:active?accent:"rgba(255,255,255,0.9)",color:active?"#fff":"var(--color-text-primary)",cursor:"pointer",fontSize:12.5,fontWeight:active?600:500}}>
            {participant.name}
          </button>
        );
      })}
      {extra}
    </div>
  );
}

function WolfControls({game, state, holeIndex, onChoice}) {
  const wolfHole = state.wolf?.holes[holeIndex];
  if (!wolfHole?.wolfId) return null;
  const wolfName = state.nameById.get(wolfHole.wolfId);
  const choice = game.wolfChoices[holeIndex] || {};
  const candidates = game.participants.filter(p=>p.playerId !== wolfHole.wolfId);
  const rotationOver = holeIndex >= (state.wolf?.rotationHoles ?? 0);

  const chip = (active, label, onClick, accent) => (
    <button type="button" onClick={onClick}
      style={{padding:"7px 12px",borderRadius:"999px",border:`1px solid ${active?"transparent":"var(--color-border-secondary)"}`,background:active?accent:"rgba(255,255,255,0.9)",color:active?"#fff":"var(--color-text-primary)",cursor:"pointer",fontSize:12.5,fontWeight:active?600:500}}>
      {label}
    </button>
  );

  return (
    <div style={{...subtleCardStyle,padding:"12px 14px",marginBottom:12}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",gap:10,marginBottom:8}}>
        <span style={{fontSize:11,fontWeight:700,letterSpacing:"0.08em",textTransform:"uppercase",color:COLORS.textSec}}>Wolf</span>
        <span style={{fontSize:12.5,fontWeight:600}}>{wolfName}{rotationOver ? " (Punktletzter)" : ""}</span>
      </div>
      <PlayerChips
        participants={candidates}
        value={choice.partnerId ?? null}
        accent="#7F77DD"
        onSelect={partnerId=>onChoice(holeIndex, {partnerId, blind:false})}
        extra={<>
          {chip(!choice.partnerId && !choice.blind, "Lone Wolf · 3", ()=>onChoice(holeIndex, {partnerId:null, blind:false}), "#C56B1A")}
          {chip(!choice.partnerId && Boolean(choice.blind), "Blind Wolf · 4", ()=>onChoice(holeIndex, {partnerId:null, blind:true}), "#9a5314")}
        </>}
      />
      {wolfHole.outcome && (
        <div style={{fontSize:12,color:COLORS.textSec,marginTop:8}}>
          {wolfHole.outcome === "halved"
            ? "Loch geteilt – keine Punkte"
            : `${wolfHole.outcome === "wolf" ? "Wolf-Seite" : "Gegenseite"} gewinnt · ${Object.entries(wolfHole.points).map(([id, value])=>`${state.nameById.get(id)} +${value}`).join(", ")}`}
        </div>
      )}
    </div>
  );
}

function BbbControls({game, state, holeIndex, onAward}) {
  const entry = game.bbbAwards[holeIndex] || {};
  return (
    <div style={{...subtleCardStyle,padding:"12px 14px",marginBottom:12}}>
      <div style={{fontSize:11,fontWeight:700,letterSpacing:"0.08em",textTransform:"uppercase",color:COLORS.textSec,marginBottom:8}}>Bingo Bango Bongo</div>
      {BBB_AWARDS.map(award=>(
        <div key={award.key} style={{marginBottom:8}}>
          <div style={{fontSize:12,color:COLORS.textSec,marginBottom:4}}><strong style={{color:"var(--color-text-primary)"}}>{award.label}</strong> · {award.hint}</div>
          <PlayerChips
            participants={game.participants}
            value={entry[award.key] ?? null}
            accent="#378ADD"
            onSelect={playerId=>onAward(holeIndex, award.key, playerId)}
          />
        </div>
      ))}
    </div>
  );
}

function NassauPressControls({game, state, holeIndex, onPress}) {
  const segments = nassauSegments(game.holeCount);
  const segment = segments.find(entry=>entry.key !== "total" && holeIndex >= entry.from && holeIndex < entry.to)
    ?? segments[segments.length-1];
  const alreadyPressed = game.nassauPresses.some(press=>press.segment === segment.key && press.from === holeIndex);
  const bet = state.nassau?.bets.find(entry=>entry.key === segment.key);
  const canPress = holeIndex + 1 < segment.to;

  return (
    <div style={{...subtleCardStyle,padding:"12px 14px",marginBottom:12,display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,flexWrap:"wrap"}}>
      <div>
        <div style={{fontSize:11,fontWeight:700,letterSpacing:"0.08em",textTransform:"uppercase",color:COLORS.textSec}}>Nassau · {segment.label}</div>
        <div style={{fontSize:13,marginTop:2}}>{bet ? bet.result.statusLabel : "A/S"}</div>
      </div>
      <button type="button" disabled={alreadyPressed || !canPress}
        onClick={()=>onPress({from:holeIndex, segment:segment.key})}
        style={{...gamesGhostBtn,padding:"8px 14px",fontSize:13,opacity:(alreadyPressed || !canPress)?0.4:1,cursor:(alreadyPressed || !canPress)?"not-allowed":"pointer"}}>
        {alreadyPressed ? "Press läuft" : "Press ab hier"}
      </button>
    </div>
  );
}

function GameHoleEntry({game, state, onScore, onChoice, onAward, onPress, onFinish, onExit}) {
  // Beim Öffnen auf das erste noch unvollständige Loch springen.
  const [holeIndex, setHoleIndex] = useState(()=>{
    for (let index = 0; index < game.holeCount; index += 1) {
      if (state.ids.some(id=>!Number.isFinite(game.scores[index]?.[id]))) return index;
    }
    return game.holeCount - 1;
  });
  const hole = game.holes[holeIndex];

  return (
    <div>
      <div style={{...cardStyle,padding:"18px 20px",marginBottom:14}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,marginBottom:16}}>
          <button type="button" onClick={()=>setHoleIndex(i=>Math.max(0, i-1))} disabled={holeIndex === 0}
            style={{...gamesGhostBtn,padding:"10px 16px",opacity:holeIndex === 0 ? 0.35 : 1}}>←</button>
          <div style={{textAlign:"center"}}>
            <div style={{fontSize:26,fontWeight:700,lineHeight:1}}>Loch {hole.nr}</div>
            <div style={{fontSize:12,color:COLORS.textSec,marginTop:4}}>Par {hole.par} · SI {hole.si} · {holeIndex+1}/{game.holeCount}</div>
          </div>
          <button type="button" onClick={()=>setHoleIndex(i=>Math.min(game.holeCount-1, i+1))} disabled={holeIndex === game.holeCount-1}
            style={{...gamesGhostBtn,padding:"10px 16px",opacity:holeIndex === game.holeCount-1 ? 0.35 : 1}}>→</button>
        </div>

        {game.participants.map(participant=>{
          const allocation = state.allocationById.get(participant.playerId);
          const strokes = allocation?.strokes[holeIndex] ?? 0;
          const gross = game.scores[holeIndex]?.[participant.playerId];
          const net = Number.isFinite(gross) ? gross - strokes : null;
          return (
            <div key={participant.playerId} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 0",borderTop:"1px solid var(--color-border-tertiary)"}}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:14,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{participant.name}</div>
                <div style={{fontSize:11,color:COLORS.textSec,display:"flex",alignItems:"center",gap:6}}>
                  <StrokeDots strokes={strokes}/>
                  {net !== null ? <span>netto {net}</span> : <span>Vorgabe {allocation?.gameHandicap ?? 0}</span>}
                </div>
              </div>
              <ScoreStepper value={gross} par={hole.par} onChange={value=>onScore(holeIndex, participant.playerId, value)}/>
            </div>
          );
        })}
      </div>

      {state.wolf && <WolfControls game={game} state={state} holeIndex={holeIndex} onChoice={onChoice}/>}
      {state.bbb && <BbbControls game={game} state={state} holeIndex={holeIndex} onAward={onAward}/>}
      {state.nassau && <NassauPressControls game={game} state={state} holeIndex={holeIndex} onPress={onPress}/>}

      <GameStandings game={game} state={state} compact/>

      <div style={{display:"flex",gap:8,marginTop:16,flexWrap:"wrap"}}>
        <button onClick={onFinish} style={gamesPrimaryBtn}>Spiel beenden</button>
        <button onClick={onExit} style={gamesGhostBtn}>Später weiterspielen</button>
      </div>
    </div>
  );
}

function GameScorecard({game, state}) {
  const cell: CSSProperties = {padding:"6px 8px",textAlign:"center",fontSize:12,borderBottom:"1px solid var(--color-border-tertiary)",whiteSpace:"nowrap"};
  const headCell: CSSProperties = {...cell,fontWeight:700,color:COLORS.textSec,fontSize:11};
  const sumFor = (playerId, from, to) => {
    let total = 0;
    let any = false;
    for (let index = from; index < to; index += 1) {
      const value = game.scores[index]?.[playerId];
      if (Number.isFinite(value)) { total += value; any = true; }
    }
    return any ? total : "–";
  };

  return (
    <div style={{overflowX:"auto",WebkitOverflowScrolling:"touch"}}>
      <table style={{borderCollapse:"collapse",minWidth:"100%"}}>
        <thead>
          <tr>
            <th style={{...headCell,textAlign:"left",position:"sticky",left:0,background:"rgba(255,255,255,0.96)"}}>Loch</th>
            {game.holes.map(hole=><th key={hole.nr} style={headCell}>{hole.nr}</th>)}
            {game.holeCount === 18 && <th style={headCell}>Out</th>}
            {game.holeCount === 18 && <th style={headCell}>In</th>}
            <th style={headCell}>Ges.</th>
          </tr>
          <tr>
            <th style={{...headCell,textAlign:"left",position:"sticky",left:0,background:"rgba(255,255,255,0.96)"}}>Par / SI</th>
            {game.holes.map(hole=><th key={hole.nr} style={{...headCell,fontWeight:500}}>{hole.par}<span style={{color:"var(--color-text-secondary)",opacity:0.5,margin:"0 1px"}}>/</span>{hole.si}</th>)}
            {game.holeCount === 18 && <th style={headCell}/>}
            {game.holeCount === 18 && <th style={headCell}/>}
            <th style={headCell}>{totalPar(game.holes)}</th>
          </tr>
        </thead>
        <tbody>
          {game.participants.map(participant=>{
            const allocation = state.allocationById.get(participant.playerId);
            return (
              <tr key={participant.playerId}>
                <td style={{...cell,textAlign:"left",fontWeight:600,position:"sticky",left:0,background:"rgba(255,255,255,0.96)"}}>{participant.name}</td>
                {game.holes.map((hole, index)=>{
                  const gross = game.scores[index]?.[participant.playerId];
                  const strokes = allocation?.strokes[index] ?? 0;
                  const skinWinner = state.skins?.holes[index]?.winnerId === participant.playerId;
                  return (
                    <td key={hole.nr} style={{...cell,background:skinWinner?"#ecfbf4":undefined,fontWeight:skinWinner?700:400,position:"relative"}}>
                      {Number.isFinite(gross) ? gross : "–"}
                      {Number.isFinite(gross) && strokes > 0 && <sup style={{color:COLORS.hcp,fontSize:9,marginLeft:1}}>{strokes}</sup>}
                    </td>
                  );
                })}
                {game.holeCount === 18 && <td style={{...cell,fontWeight:600}}>{sumFor(participant.playerId, 0, 9)}</td>}
                {game.holeCount === 18 && <td style={{...cell,fontWeight:600}}>{sumFor(participant.playerId, 9, 18)}</td>}
                <td style={{...cell,fontWeight:700}}>{sumFor(participant.playerId, 0, game.holeCount)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{fontSize:11,color:COLORS.textSec,marginTop:8}}>
        Hochgestellt = Vorgabenschläge auf diesem Loch{state.skins ? " · grün hinterlegt = Skin gewonnen" : ""}
      </div>
    </div>
  );
}

function GameResultView({game, state, meParticipant, onCreateHcpRound, onReopen, onExit}) {
  const {balanceList} = state;
  const transfers = useMemo(()=>buildSettlement(balanceList), [balanceList]);

  // Für die HCP-Übernahme zählt immer das volle Course Handicap, nicht die
  // Lochspiel-Differenz aus diesem Spiel.
  const hcpPreview = useMemo(()=>{
    if (!meParticipant) return null;
    const [allocation] = buildAllocations(
      [{id: meParticipant.playerId, courseHandicap: meParticipant.courseHandicap}],
      game.holes,
      {mode:"full", percent:100},
    );
    return {
      allocation,
      summary: stablefordFromHoles(meParticipant.playerId, game.scores, allocation, game.holes),
    };
  }, [game, meParticipant]);

  return (
    <div>
      <GameStandings game={game} state={state}/>

      <div style={{...cardStyle,padding:"16px 18px",marginTop:14}}>
        <div style={{fontSize:11,fontWeight:700,letterSpacing:"0.08em",textTransform:"uppercase",color:COLORS.textSec,marginBottom:10}}>Abrechnung</div>
        {balanceList.map(entry=>(
          <div key={entry.id} style={{display:"flex",justifyContent:"space-between",fontSize:14,padding:"5px 0",borderBottom:"1px solid var(--color-border-tertiary)"}}>
            <span>{entry.name}</span>
            <strong style={{color:entry.amount > 0 ? COLORS.hcp : entry.amount < 0 ? "#E24B4A" : COLORS.textSec}}>
              {formatSignedStake(entry.amount)}
            </strong>
          </div>
        ))}
        {transfers.length > 0 ? (
          <div style={{marginTop:12,fontSize:13,color:COLORS.textSec}}>
            {transfers.map((transfer, index)=>(
              <div key={index}>{transfer.from} an {transfer.to}: <strong style={{color:"var(--color-text-primary)"}}>{formatStake(transfer.amount)}</strong></div>
            ))}
          </div>
        ) : (
          <div style={{marginTop:12,fontSize:13,color:COLORS.textSec}}>Ausgeglichen – kein Punkt geht hin oder her.</div>
        )}
      </div>

      <div style={{...cardStyle,padding:"16px 18px",marginTop:14}}>
        <div style={{fontSize:11,fontWeight:700,letterSpacing:"0.08em",textTransform:"uppercase",color:COLORS.textSec,marginBottom:10}}>Scorekarte</div>
        <GameScorecard game={game} state={state}/>
      </div>

      {hcpPreview && (
        <div style={{...cardStyle,padding:"16px 18px",marginTop:14}}>
          <div style={{fontSize:11,fontWeight:700,letterSpacing:"0.08em",textTransform:"uppercase",color:COLORS.textSec,marginBottom:8}}>In den HCP-Tracker übernehmen</div>
          {game.hcpRoundId ? (
            <div style={{fontSize:13,color:"#085041"}}>✓ Bereits als Runde übernommen.</div>
          ) : hcpPreview.summary.complete ? (
            <>
              <div style={{fontSize:13,color:COLORS.textSec,marginBottom:12}}>
                Aus deinen Schlägen: <strong style={{color:"var(--color-text-primary)"}}>{hcpPreview.summary.netPoints} Netto-Stableford-Punkte</strong> bei
                Brutto {hcpPreview.summary.grossTotal} und Spielvorgabe {hcpPreview.allocation.gameHandicap}. Eingereicht und Marker-Unterschrift trägst du im nächsten Schritt ein.
              </div>
              <button onClick={()=>onCreateHcpRound({
                date: game.date,
                courseId: game.courseId,
                courseName: game.courseName,
                courseRating: game.courseRating,
                slopeRating: game.slopeRating,
                par: game.coursePar,
                holes: game.holeCount,
                mode: "Stableford",
                format: "Einzel",
                playingHcp: hcpPreview.allocation.gameHandicap,
                stablefordPoints: hcpPreview.summary.netPoints,
                submitted: false,
                markerSigned: false,
                nineHoleAllowed: false,
                gameId: game.id,
              })} style={gamesPrimaryBtn}>Als HCP-Runde speichern</button>
            </>
          ) : (
            <div style={{fontSize:13,color:COLORS.textSec}}>
              Erst wenn alle {game.holeCount} Löcher erfasst sind ({hcpPreview.summary.holesCounted} bisher), lässt sich daraus eine HCP-Runde ableiten.
            </div>
          )}
        </div>
      )}

      <div style={{display:"flex",gap:8,marginTop:16,flexWrap:"wrap"}}>
        <button onClick={onExit} style={gamesPrimaryBtn}>Fertig</button>
        <button onClick={onReopen} style={gamesGhostBtn}>Scores nachtragen</button>
      </div>
    </div>
  );
}

function GameRow({game, onOpen, onDelete}) {
  const state = useGameState(game);
  const running = game.status === "running";
  const leader = totals => {
    const best = [...state.ids].sort((a,b)=>(totals[b] || 0) - (totals[a] || 0))[0];
    return `${state.nameById.get(best)} ${totals[best] || 0}`;
  };
  const summary = [];
  if (state.matchplay) summary.push(`Matchplay ${state.matchplay.resultLabel ?? state.matchplay.statusLabel}`);
  if (state.nassau) summary.push(`Nassau ${state.nassau.totals.a}:${state.nassau.totals.b}`);
  if (state.skins) summary.push(`Skins: ${leader(state.skins.totals)}`);
  if (state.wolf) summary.push(`Wolf: ${leader(state.wolf.totals)}`);
  if (state.bbb) summary.push(`BBB: ${leader(state.bbb.totals)}`);

  return (
    <div style={{display:"flex",alignItems:"center",gap:12,padding:"12px 14px",borderRadius:"var(--border-radius-md)",border:`1px solid ${running?"rgba(29,158,117,0.38)":"var(--color-border-tertiary)"}`,background:running?"linear-gradient(180deg, #ecfbf4 0%, #e3f6ee 100%)":"rgba(255,255,255,0.9)",boxShadow:"var(--shadow-soft)",marginBottom:10}}>
      <div style={{flex:1,minWidth:0}}>
        <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
          <span style={{fontWeight:600,fontSize:14}}>{game.participants.map(p=>p.name).join(" · ")}</span>
          {running ? badge("läuft", "#E1F5EE", "#085041") : badge("beendet", "#F1EFE8", "#5F5E5A")}
          {game.handicap.mode === "gross" ? badge("Brutto", "#E6F1FB", "#0C447C") : badge(`Netto ${game.handicap.percent}%`, "#EEEDFE", "#3C3489")}
        </div>
        <div style={{fontSize:12,color:COLORS.textSec,marginTop:2}}>
          {game.date} · {game.courseName} · {game.holeCount} Loch · {state.played}/{game.holeCount} erfasst
        </div>
        {summary.length > 0 && (
          <div style={{fontSize:12,color:"var(--color-text-primary)",marginTop:3,fontWeight:500}}>{summary.join("  ·  ")}</div>
        )}
      </div>
      <div style={{display:"flex",gap:6,flexShrink:0}}>
        <button onClick={onOpen} style={{padding:"6px 12px",borderRadius:"var(--border-radius-md)",border:"none",background:COLORS.hcp,color:"#fff",cursor:"pointer",fontSize:12,fontWeight:600}}>
          {running ? "Weiter" : "Ansehen"}
        </button>
        <button onClick={onDelete} style={{padding:"6px 10px",borderRadius:"var(--border-radius-md)",border:"0.5px solid #E24B4A",background:"transparent",cursor:"pointer",fontSize:12,color:"#E24B4A"}}>Löschen</button>
      </div>
    </div>
  );
}

/** Bilanz aus allen beendeten Matchplay-Spielen, je Gegner. */
function HeadToHead({games, mePlayerId}) {
  const records = useMemo(()=>{
    const map = new Map();
    for (const game of games) {
      if (game.status !== "finished") continue;
      if (!game.formats.includes("matchplay") || game.matchup?.length !== 2) continue;
      if (!game.matchup.includes(mePlayerId)) continue;

      const allocations = buildAllocations(
        game.participants.map(p=>({id:p.playerId, courseHandicap:p.courseHandicap})),
        game.holes,
        game.handicap,
      );
      const result = scoreMatchplay(game.matchup[0], game.matchup[1], game.scores, allocations, game.holes);
      if (!result.complete) continue;

      const meIsA = game.matchup[0] === mePlayerId;
      const opponentId = meIsA ? game.matchup[1] : game.matchup[0];
      const opponent = game.participants.find(p=>p.playerId === opponentId);
      if (!opponent) continue;

      const entry = map.get(opponentId) || {name:opponent.name, won:0, lost:0, halved:0};
      if (!result.winner) entry.halved += 1;
      else if ((result.winner === "a") === meIsA) entry.won += 1;
      else entry.lost += 1;
      map.set(opponentId, entry);
    }
    return [...map.values()].sort((a,b)=>(b.won + b.lost + b.halved) - (a.won + a.lost + a.halved));
  }, [games, mePlayerId]);

  if (!records.length) return null;

  return (
    <div style={{...cardStyle,padding:"16px 18px",marginBottom:16}}>
      <div style={{fontSize:11,fontWeight:700,letterSpacing:"0.08em",textTransform:"uppercase",color:COLORS.textSec,marginBottom:10}}>Bilanz im Matchplay</div>
      {records.map(record=>(
        <div key={record.name} style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:14,padding:"6px 0",borderBottom:"1px solid var(--color-border-tertiary)"}}>
          <span>gegen {record.name}</span>
          <span style={{display:"flex",gap:8,fontSize:13}}>
            <span style={{color:COLORS.hcp,fontWeight:700}}>{record.won} S</span>
            <span style={{color:COLORS.textSec}}>{record.halved} U</span>
            <span style={{color:"#E24B4A",fontWeight:700}}>{record.lost} N</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function GamePlayView({game, onScore, onChoice, onAward, onPress, onFinish, onReopen, onExit, onCreateHcpRound}) {
  const state = useGameState(game);
  const meParticipant = game.participants.find(p=>p.isMe);
  if (game.status === "finished") {
    return <GameResultView game={game} state={state} meParticipant={meParticipant} onCreateHcpRound={onCreateHcpRound} onReopen={onReopen} onExit={onExit}/>;
  }
  return <GameHoleEntry game={game} state={state} onScore={onScore} onChoice={onChoice} onAward={onAward} onPress={onPress} onFinish={onFinish} onExit={onExit}/>;
}

function GamesView({games, courses, players, profile, displayHcp, onStartGame, onAddPlayer, onUpdatePlayer, onUpsertCourse, onScore, onWolfChoice, onBbbAward, onNassauPress, onFinishGame, onReopenGame, onDeleteGame, onCreateHcpRound}) {
  const [screen, setScreen] = useState<{mode:"list"|"setup"|"play"; gameId?:number}>({mode:"list"});
  const [sharedGame, setSharedGame] = useState(null);
  const openGame = games.find(g=>g.id === screen.gameId);
  const mePlayer = players.find(p=>p.isMe);

  // Geteilt wird nur das Setup, nie der Spielstand: Jeder schreibt selbst mit.
  const sharedGameCard = useMemo(()=>{
    if (!sharedGame) return null;
    const course = courses.find(c=>c.id === sharedGame.courseId);
    const ids = sharedGame.participants.map(participant=>participant.playerId);
    return {
      kind: "game",
      date: sharedGame.date,
      holeCount: sharedGame.holeCount,
      course: {
        name: sharedGame.courseName,
        courseRating: parseFloat(sharedGame.courseRating),
        slopeRating: parseFloat(sharedGame.slopeRating),
        par: parseInt(sharedGame.coursePar, 10),
        tee: course?.tee,
        holeCount: sharedGame.holeCount,
        holeData: sharedGame.holes?.map(hole=>({par: hole.par, si: hole.si})),
      },
      formats: sharedGame.formats,
      matchup: (sharedGame.matchup || []).map(id=>ids.indexOf(id)).filter(index=>index >= 0),
      handicap: {mode: sharedGame.handicap.mode, percent: sharedGame.handicap.percent},
      stake: sharedGame.stake,
      players: sharedGame.participants.map(participant=>({name: participant.name, hcpIndex: participant.hcpIndex})),
    } as GameCard;
  },[sharedGame, courses]);

  if (screen.mode === "setup") {
    return (
      <div style={{...cardStyle,padding:"20px 22px"}}>
        <h2 style={{fontSize:18,fontWeight:600,margin:"0 0 16px"}}>Neues Spiel</h2>
        <GameSetupForm
          courses={courses}
          players={players}
          profileName={profile.name}
          displayHcp={displayHcp}
          onStart={draft=>setScreen({mode:"play", gameId:onStartGame(draft)})}
          onAddPlayer={onAddPlayer}
          onUpdatePlayer={onUpdatePlayer}
          onUpsertCourse={onUpsertCourse}
          onCancel={()=>setScreen({mode:"list"})}
        />
      </div>
    );
  }

  if (screen.mode === "play" && openGame) {
    return (
      <div>
        <div style={{display:"flex",alignItems:"baseline",justifyContent:"space-between",gap:12,marginBottom:14,flexWrap:"wrap"}}>
          <h2 style={{fontSize:18,fontWeight:600,margin:0}}>{openGame.courseName}</h2>
          <div style={{display:"flex",gap:8}}>
            <button onClick={()=>setSharedGame(openGame)} style={{...gamesGhostBtn,padding:"6px 12px",fontSize:13}}>Teilen</button>
            <button onClick={()=>setScreen({mode:"list"})} style={{...gamesGhostBtn,padding:"6px 12px",fontSize:13}}>Übersicht</button>
          </div>
        </div>
        {sharedGameCard && (
          <Modal title="Spiel teilen" onClose={()=>setSharedGame(null)} maxWidth={620}>
            <ShareCardPanel
              card={sharedGameCard}
              hint="Jeder scannt den Code mit der Kamera seines Telefons und bekommt dasselbe Spiel: gleiche Spieler, gleiche Formate, gleiche Einsätze. Dann schreibt jeder selbst mit, und am Ende vergleicht ihr die Abrechnungen. Übertragen werden nur die Eingaben – Vorgaben rechnet jedes Gerät daraus selbst, damit alle auf dasselbe Ergebnis kommen."
            />
          </Modal>
        )}
        <GamePlayView
          game={openGame}
          onScore={(holeIndex, playerId, value)=>onScore(openGame.id, holeIndex, playerId, value)}
          onChoice={(holeIndex, choice)=>onWolfChoice(openGame.id, holeIndex, choice)}
          onAward={(holeIndex, award, playerId)=>onBbbAward(openGame.id, holeIndex, award, playerId)}
          onPress={press=>onNassauPress(openGame.id, press)}
          onFinish={()=>onFinishGame(openGame.id)}
          onReopen={()=>onReopenGame(openGame.id)}
          onExit={()=>setScreen({mode:"list"})}
          onCreateHcpRound={prefill=>onCreateHcpRound(openGame.id, prefill)}
        />
      </div>
    );
  }

  const running = games.filter(g=>g.status === "running");
  const finished = games.filter(g=>g.status === "finished");
  const noCourses = courses.length === 0;

  return (
    <div>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,marginBottom:16,flexWrap:"wrap"}}>
        <div>
          <h2 style={{fontSize:18,fontWeight:600,margin:0}}>Games</h2>
          <p style={{fontSize:13,color:COLORS.textSec,margin:"4px 0 0"}}>Matchplay und Skins gegen deine Mitspieler</p>
        </div>
        <button onClick={()=>setScreen({mode:"setup"})} disabled={noCourses}
          style={{...gamesPrimaryBtn,opacity:noCourses?0.5:1,cursor:noCourses?"not-allowed":"pointer"}}>Neues Spiel</button>
      </div>

      {noCourses && (
        <div style={{...cardStyle,padding:"16px 18px",marginBottom:16,fontSize:13,color:COLORS.textSec}}>
          Für Games braucht es mindestens einen Platz mit Course Rating und Slope. Lege ihn unter <strong>Plätze</strong> an.
        </div>
      )}

      {running.length > 0 && (
        <div style={{marginBottom:20}}>
          <div style={{fontSize:11,fontWeight:700,letterSpacing:"0.08em",textTransform:"uppercase",color:COLORS.textSec,marginBottom:8}}>Laufend</div>
          {running.map(game=>(
            <GameRow key={game.id} game={game} onOpen={()=>setScreen({mode:"play", gameId:game.id})} onDelete={()=>onDeleteGame(game.id)}/>
          ))}
        </div>
      )}

      {mePlayer && <HeadToHead games={games} mePlayerId={String(mePlayer.id)}/>}

      <div>
        <div style={{fontSize:11,fontWeight:700,letterSpacing:"0.08em",textTransform:"uppercase",color:COLORS.textSec,marginBottom:8}}>Historie</div>
        {finished.length === 0
          ? <div style={{...subtleCardStyle,padding:"18px 20px",fontSize:13,color:COLORS.textSec}}>Noch keine beendeten Spiele.</div>
          : finished.map(game=>(
              <GameRow key={game.id} game={game} onOpen={()=>setScreen({mode:"play", gameId:game.id})} onDelete={()=>onDeleteGame(game.id)}/>
            ))}
      </div>
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

function UsageCounterSetting() {
  const [enabled, setEnabled] = useState(()=>isUsagePingEnabled());
  const [stats, setStats] = useState<UsageStats|null>(null);
  const [status, setStatus] = useState("loading");

  useEffect(()=>{
    if (!enabled) { setStats(null); setStatus("off"); return; }
    let cancelled = false;
    setStatus("loading");
    // Erst den eigenen Ping abwarten, sonst zeigt die Zahl das eigene Geraet nicht.
    whenUsagePingSettled().then(fetchUsageStats).then(result=>{
      if (cancelled) return;
      setStats(result);
      setStatus(result ? "ready" : "unavailable");
    });
    return ()=>{ cancelled = true; };
  },[enabled]);

  const num = value => value.toLocaleString("de-DE");

  return (
    <div style={{...subtleCardStyle,padding:"12px 14px",marginTop:10,marginBottom:6}}>
      <label style={{display:"flex",alignItems:"flex-start",gap:8,fontSize:13,cursor:"pointer",color:"var(--color-text-primary)"}}>
        <input type="checkbox" checked={enabled} onChange={e=>setEnabled(setUsagePingEnabled(e.target.checked))} style={{marginTop:2}}/>
        <span>Anonymen Nutzungszähler aktiv lassen</span>
      </label>
      <div style={{fontSize:12,color:"var(--color-text-secondary)",marginTop:8,lineHeight:1.6}}>
        {status==="off" && "Zähler ist aus. Es wird nichts gesendet, die Installations-ID auf diesem Gerät ist gelöscht."}
        {status==="loading" && "Zahlen werden geladen …"}
        {status==="unavailable" && "Zahlen sind gerade nicht abrufbar (offline oder Zähl-Endpoint nicht eingerichtet)."}
        {status==="ready" && stats && (
          <>
            <div style={{fontSize:13,fontWeight:600,color:"var(--color-text-primary)"}}>
              {num(stats.activeLast30Days)} {stats.activeLast30Days===1?"Gerät":"Geräte"} in den letzten 30 Tagen aktiv
            </div>
            <div style={{marginTop:2}}>
              heute {num(stats.activeToday)} · letzte 7 Tage {num(stats.activeLast7Days)} · insgesamt gezählt {num(stats.total)}
            </div>
            <div style={{marginTop:2}}>
              Gezählt werden Geräte bzw. Browser-Installationen, nicht Personen: dasselbe Handy und derselbe Laptop sind zwei.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function HcpInfo({onOpenLegal}) {
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
        {p("Das erwartete Differenzial für die zweiten neun Löcher entnimmt das WHS einer veröffentlichten Tabelle, die aus einer modellierten Score-Verteilung stammt. Diese App nutzt dafür eine lineare Annäherung (erwartetes 18-Loch-Differenzial = 1,04 × Index + 2,4, halbiert). Bei 9-Loch-Runden kann der Wert deshalb leicht von der offiziellen Rechnung abweichen; 18-Loch-Runden sind davon nicht betroffen.")}
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
        {h("Datenschutz und Impressum")}
        {p("Die App speichert Runden, Plätze und Profildaten lokal im Browser auf deinem Gerät. Es gibt keinen Login und keine Server-Synchronisation: Deine Runden, dein Name und deine Handicap-Werte verlassen dieses Gerät nicht. Es sind keine Analyse-Werkzeuge und keine Drittanbieter eingebunden, und es werden keine Cookies gesetzt.")}
        {p("Damit sichtbar ist, wie viele Geräte die App überhaupt nutzen, sendet sie höchstens einmal pro Kalendertag eine zufällig erzeugte Installations-ID an ihren eigenen Zähl-Endpoint – sonst nichts. Abschnitt 4 der Datenschutzerklärung beschreibt das im Detail; hier kannst du es abschalten:")}
        <UsageCounterSetting/>
        {p("Welche Daten wo liegen, wie lange sie bleiben und welche Rechte du hast, steht ausführlich in der Datenschutzerklärung.")}
        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:4}}>
          <button
            type="button"
            onClick={()=>onOpenLegal("datenschutz")}
            style={{padding:"10px 14px",borderRadius:"var(--border-radius-md)",background:"#E1F1FB",color:"#0C447C",border:"1px solid rgba(12,68,124,0.18)",fontFamily:"var(--font-sans)",fontSize:13,fontWeight:600,cursor:"pointer"}}
          >
            Datenschutzerklärung
          </button>
          <button
            type="button"
            onClick={()=>onOpenLegal("impressum")}
            style={{padding:"10px 14px",borderRadius:"var(--border-radius-md)",background:"#F5F4F0",color:"var(--color-text-primary)",border:"0.5px solid var(--color-border-secondary)",fontFamily:"var(--font-sans)",fontSize:13,fontWeight:600,cursor:"pointer"}}
          >
            Impressum
          </button>
        </div>
      </>)}
    </div>
  );
}

const legalTextStyle: CSSProperties = { fontSize:14, lineHeight:1.7, color:"var(--color-text-secondary)", margin:"0 0 10px" };
const legalLinkStyle: CSSProperties = { color:"#0C447C", textDecoration:"none", fontWeight:600 };
const legalLinkButtonStyle: CSSProperties = { ...legalLinkStyle, background:"none", border:"none", padding:0, margin:0, cursor:"pointer", fontFamily:"var(--font-sans)", fontSize:13, textAlign:"left" };

function LegalCard({title, children}: {title:string, children:ReactNode}) {
  return (
    <section style={{...cardStyle,padding:"18px 20px",marginBottom:14}}>
      <h2 style={{fontSize:16,fontWeight:600,margin:"0 0 10px",color:"var(--color-text-primary)"}}>{title}</h2>
      {children}
    </section>
  );
}

function LegalP({children}: {children:ReactNode}) {
  return <p style={legalTextStyle}>{children}</p>;
}

function LegalList({items}: {items:ReactNode[]}) {
  return (
    <ul style={{margin:"0 0 10px",paddingLeft:20}}>
      {items.map((item,i)=><li key={i} style={{...legalTextStyle,margin:"0 0 6px"}}>{item}</li>)}
    </ul>
  );
}

// Pflichtangaben werden nicht stillschweigend weggelassen, sondern sichtbar markiert,
// solange sie fehlen.
function LegalValue({value, placeholder}) {
  const text = String(value||"").trim();
  if (text) return <>{text}</>;
  return (
    <span style={{color:"#8A5310",background:"rgba(214,148,40,0.16)",borderRadius:6,padding:"1px 7px",fontSize:13,fontWeight:600}}>
      {placeholder}
    </span>
  );
}

function LegalTodoNotice() {
  const missing = missingLegalFields();
  if (!missing.length) return null;
  return (
    <div style={{...subtleCardStyle,padding:"14px 16px",marginBottom:14,background:"linear-gradient(180deg, rgba(255,247,233,0.98) 0%, rgba(255,251,243,0.96) 100%)",border:"1px solid rgba(190,120,20,0.28)"}}>
      <div style={{fontSize:13,fontWeight:700,color:"#8A5310",marginBottom:6}}>Pflichtangaben fehlen noch</div>
      <div style={{fontSize:13,lineHeight:1.6,color:"#6B4310"}}>
        Es fehlen: {missing.join(", ")}. Die App ist unter {LEGAL.site.domain} öffentlich erreichbar und dient damit nicht mehr ausschließlich persönlichen Zwecken – diese Angaben sind nach § 18 Abs. 1 MStV und § 5 DDG erforderlich. Gepflegt werden sie im Quellcode unter <code>LEGAL</code> in <code>golf_hcp_tracker.tsx</code>.
      </div>
    </div>
  );
}

function LegalContactBlock() {
  const { name, street, postalCity, country, email, phone, contactUrl, contactLabel } = LEGAL.operator;
  return (
    <div style={{...subtleCardStyle,padding:"14px 16px",marginBottom:12,fontSize:14,lineHeight:1.7,color:"var(--color-text-secondary)"}}>
      <div style={{fontWeight:600,color:"var(--color-text-primary)"}}>{name}</div>
      <div><LegalValue value={street} placeholder="Straße und Hausnummer ergänzen"/></div>
      <div><LegalValue value={postalCity} placeholder="PLZ und Ort ergänzen"/></div>
      {country && <div>{country}</div>}
      <div style={{marginTop:8}}>
        E-Mail:{" "}
        {String(email||"").trim()
          ? <a href={`mailto:${email}`} style={legalLinkStyle}>{email}</a>
          : <LegalValue value="" placeholder="Kontakt-E-Mail ergänzen"/>}
      </div>
      {String(phone||"").trim() && <div>Telefon: {phone}</div>}
      <div>
        Weiterer Kontaktweg: <a href={contactUrl} target="_blank" rel="noreferrer" style={legalLinkStyle}>{contactLabel}</a>
      </div>
    </div>
  );
}

function Impressum() {
  return (
    <div>
      <LegalTodoNotice/>

      <LegalCard title="Angaben gemäß § 5 DDG und § 18 Abs. 1 MStV">
        <LegalP>Anbieter des unter {LEGAL.site.domain} erreichbaren Angebots und verantwortlich für den Inhalt nach § 18 Abs. 2 Medienstaatsvertrag (MStV):</LegalP>
        <LegalContactBlock/>
        <LegalP>Die E-Mail-Adresse ist der offizielle Kontaktweg für rechtliche Anliegen und Datenschutzanfragen. Fehler, Rückfragen und Verbesserungsvorschläge zur App werden dagegen im Repository am schnellsten gesehen:</LegalP>
        <div style={{fontSize:14,lineHeight:1.8}}>
          <a href={GITHUB_ISSUES_URL} target="_blank" rel="noreferrer" style={legalLinkStyle}>Issue auf GitHub anlegen</a>
        </div>
      </LegalCard>

      <LegalCard title="Art des Angebots">
        <LegalP>Wolf Golf ist ein kostenloses, nicht-kommerzielles Freizeitprojekt. Es gibt keine Werbung, keine Bezahlfunktionen, keine Verträge, keine Spendenaufrufe und keine Vermarktung von Daten. Die Nutzung ist ohne Registrierung möglich.</LegalP>
        <LegalP>Seit die App unter einer eigenen Domain öffentlich abrufbar ist, dient sie nicht mehr ausschließlich persönlichen oder familiären Zwecken. Deshalb enthält dieses Impressum die vollständige Anbieterkennzeichnung mit Name, ladungsfähiger Anschrift und E-Mail-Adresse – unabhängig davon, dass mit der App kein Geld verdient wird.</LegalP>
      </LegalCard>

      <LegalCard title="Haftung für Inhalte und Berechnungen">
        <LegalP>Die App berechnet Score Differenziale und den Handicap-Index nach den Regeln des World Handicap System (WHS) in der Auslegung des Deutschen Golf Verbands (DGV). Die Berechnungen erfolgen nach bestem Wissen, sind aber unverbindlich und können von der offiziellen Führung abweichen – zum Beispiel weil die Platzverhältnis-Korrektur (PCC) mit 0 angenommen wird.</LegalP>
        <LegalP>Verbindlich ist ausschließlich der von deinem Heimatclub beziehungsweise über den DGV geführte Handicap-Index. Für die Richtigkeit, Vollständigkeit und Aktualität der Berechnungen und Inhalte wird keine Haftung übernommen. Die Nutzung erfolgt auf eigenes Risiko; insbesondere ersetzt die App keine Datensicherung deiner Runden.</LegalP>
      </LegalCard>

      <LegalCard title="Haftung für Links">
        <LegalP>Die App verweist auf externe Seiten (GitHub). Für deren Inhalte sind ausschließlich die jeweiligen Anbieter verantwortlich. Zum Zeitpunkt der Verlinkung waren keine rechtswidrigen Inhalte erkennbar. Eine dauerhafte inhaltliche Kontrolle verlinkter Seiten ist ohne konkrete Anhaltspunkte für eine Rechtsverletzung nicht zumutbar. Bei bekannt werdenden Rechtsverstößen werden solche Links entfernt.</LegalP>
      </LegalCard>

      <LegalCard title="Urheberrecht, Lizenz und Marken">
        <LegalP>Der Quellcode der App steht unter der MIT-Lizenz; die Lizenzbedingungen liegen im Repository (Datei LICENSE). Von dir erfasste Runden-, Platz- und Profildaten gehören dir und bleiben auf deinem Gerät.</LegalP>
        <LegalP>„World Handicap System“, „WHS“, „DGV“, „golf.de“ sowie Namen von Golfanlagen sind Kennzeichen der jeweiligen Rechteinhaber und werden hier nur beschreibend verwendet. Es besteht keine Verbindung zum DGV, zu golf.de oder zu einzelnen Golfanlagen und keine Zusammenarbeit mit ihnen.</LegalP>
      </LegalCard>

      <LegalCard title="Verbraucherstreitbeilegung">
        <LegalP>Zur Teilnahme an einem Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle sind wir nicht verpflichtet und nicht bereit.</LegalP>
      </LegalCard>
    </div>
  );
}

function Datenschutz() {
  const storageItems = [
    ["golf_hcp_db", "Profil (Anzeigename, Start-HCP), angelegte Plätze (Name, Course Rating, Slope, Par, Tee, Notizen), gespeicherte Runden (Datum, Platz, Brutto- bzw. Stableford-Ergebnis, Spielvorgabe, Kennzeichen wie „eingereicht“, „Marker unterschrieben“ und „Simulation“)."],
    ["golf_hcp_nav_collapsed", "Anzeige-Einstellung, ob die Seitennavigation eingeklappt ist."],
    ["golf_hcp_usage", "Zufällige Installations-ID für den anonymen Nutzungszähler, der Tag des letzten gesendeten Pings und dein Ein-/Aus-Schalter dazu (Abschnitt 4). Der einzige Schlüssel, dessen Inhalt das Gerät verlässt – und nur die ID."],
  ];

  return (
    <div>
      <LegalTodoNotice/>

      <LegalCard title="Das Wichtigste in vier Punkten">
        <LegalList items={[
          "Deine Runden, Plätze und Profildaten bleiben im Speicher deines Browsers auf deinem Gerät. Es gibt kein Benutzerkonto und keine Server-Synchronisation.",
          "Keine Analyse-Werkzeuge, keine Werbe-Cookies, keine Social-Media-Plugins, kein Wiedererkennen über Webseiten hinweg. Das Einzige, was übertragen wird, ist eine zufällige Installations-ID für den anonymen Nutzungszähler – höchstens einmal pro Tag, abschaltbar, siehe Abschnitt 4.",
          "Keine externen Schriftarten, Skripte oder Bibliotheken von Drittanbieter-Servern: Alles, was die App braucht, wird von ihrer eigenen Adresse geladen.",
          "Der golf.de-PDF-Import läuft vollständig in deinem Browser. Die PDF-Datei wird nicht hochgeladen.",
        ]}/>
      </LegalCard>

      <LegalCard title="1. Verantwortlicher">
        <LegalP>Diese Erklärung gilt für die unter {LEGAL.site.domain} erreichbare App. Verantwortlicher im Sinne von Art. 4 Nr. 7 DSGVO ist:</LegalP>
        <LegalContactBlock/>
        <LegalP>Anfragen zum Datenschutz richtest du am besten per E-Mail an die oben genannte Adresse. Der Weg über ein GitHub-Issue funktioniert ebenfalls, ist aber öffentlich einsehbar – gib dort nichts an, was nicht öffentlich werden soll. Ein Datenschutzbeauftragter ist nicht bestellt, da die Voraussetzungen dafür nicht vorliegen.</LegalP>
      </LegalCard>

      <LegalCard title="2. Daten, die nur auf deinem Gerät liegen">
        <LegalP>Alles, was du in der App erfasst, wird ausschließlich im <em>localStorage</em> deines Browsers gespeichert – unter diesen Schlüsseln:</LegalP>
        <div style={{border:"0.5px solid var(--color-border-tertiary)",borderRadius:"var(--border-radius-md)",overflow:"hidden",margin:"10px 0 12px"}}>
          <div style={{display:"grid",gridTemplateColumns:"minmax(120px, 0.7fr) 1.6fr",gap:12,background:"var(--color-background-secondary)",padding:"7px 12px",fontSize:11,fontWeight:600,letterSpacing:"0.04em",textTransform:"uppercase",color:"var(--color-text-secondary)"}}>
            <span>Speicherschlüssel</span><span>Inhalt</span>
          </div>
          {storageItems.map(([key, description],i)=>(
            <div key={key} style={{display:"grid",gridTemplateColumns:"minmax(120px, 0.7fr) 1.6fr",gap:12,padding:"9px 12px",fontSize:13,lineHeight:1.6,borderTop:"0.5px solid var(--color-border-tertiary)",background:i%2===0?"rgba(255,255,255,0.72)":"var(--color-background-secondary)"}}>
              <span style={{fontFamily:"monospace",fontSize:12,color:"var(--color-text-primary)",wordBreak:"break-word"}}>{key}</span>
              <span style={{color:"var(--color-text-secondary)"}}>{description}</span>
            </div>
          ))}
        </div>
        <LegalP>Diese Inhalte werden weder an den Betreiber noch an Dritte übertragen und auf keinen Server geschrieben – mit einer Ausnahme: die Installations-ID aus <em>golf_hcp_usage</em>, siehe Abschnitt 4. Deine Runden, Plätze und Profildaten sind davon nicht betroffen; der Betreiber hat keinen Zugriff darauf und kann sie nicht einsehen. Ob du dabei echte Namen von Mitspielern oder Golfanlagen einträgst, entscheidest du selbst; die App fragt keine Kontaktdaten ab.</LegalP>
      </LegalCard>

      <LegalCard title="3. Speicherung im Browser statt Cookies">
        <LegalP>Die App setzt keine Cookies. Sie nutzt den lokalen Browserspeicher (localStorage) für deine Daten und einen Service Worker mit Browser-Cache, damit die App nach dem ersten Laden auch offline funktioniert und schnell startet.</LegalP>
        <LegalP>Diese Speicherung ist unbedingt erforderlich, um die von dir ausdrücklich gewünschte Funktion bereitzustellen – Runden dauerhaft behalten und die App offline nutzen. Sie ist deshalb nach § 25 Abs. 2 Nr. 2 TDDDG einwilligungsfrei; ein Cookie-Banner ist dafür nicht erforderlich.</LegalP>
        <LegalP>Eine Ausnahme davon ist die Installations-ID des Nutzungszählers: Sie ist für den Betrieb der App nicht erforderlich. Deshalb lässt sie sich abschalten und wird dabei gelöscht – der nächste Abschnitt beschreibt sie vollständig.</LegalP>
      </LegalCard>

      <LegalCard title="4. Anonymer Nutzungszähler">
        <LegalP>Der Betreiber möchte wissen, von wie vielen Geräten die App genutzt wird – nicht, wer sie nutzt oder was darin passiert. Dafür erzeugt die App beim ersten Start eine zufällige Kennung (eine UUID, z. B. „3f2a1c4e-…“) und speichert sie unter <em>golf_hcp_usage</em> auf deinem Gerät.</LegalP>
        <LegalP>Höchstens einmal pro Kalendertag sendet die App diese Kennung an ihre eigene Adresse (den Pfad <em>/api/usage</em>). Übertragen wird ausschließlich die Kennung – keine Namen, keine Runden, keine Handicap-Werte, keine Angabe darüber, welche Funktionen du benutzt hast, und keine Seitenaufrufe. Serverseitig wird daraus nur vermerkt, dass diese Kennung an diesem Kalendertag aktiv war. IP-Adresse, Browserkennung (User-Agent), Referrer und die genaue Uhrzeit werden dabei nicht gespeichert. Es wird kein Cookie gesetzt und kein Analyse-Dienst und kein weiterer Anbieter eingeschaltet: Die Zählung läuft auf derselben Plattform, die die App ausliefert (Abschnitt 6).</LegalP>
        <LegalP>Aus der Kennung lässt sich kein Name, keine Adresse und kein Gerät ermitteln; sie steht in keiner Verbindung zu deinen Runden und wird nicht mit den Server-Logfiles zusammengeführt. Sie ist trotzdem eine pseudonyme Kennung, weshalb dieser Abschnitt sie vollständig offenlegt. Gezählt werden Installationen, nicht Personen: Handy und Laptop derselben Person ergeben zwei.</LegalP>
        <LegalP>Zweck ist ausschließlich die Reichweitenmessung in Form einer Gesamtzahl, um den Aufwand für die Weiterentwicklung einschätzen zu können. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO; das berechtigte Interesse liegt darin, die Nutzung des eigenen Angebots in minimalem Umfang zu kennen. Die Speicherung der Kennung auf deinem Gerät ist für den Betrieb der App nicht erforderlich – deshalb kannst du ihr jederzeit widersprechen (Art. 21 DSGVO), ohne Angabe von Gründen und ohne Nachteil.</LegalP>
        <LegalP>Den Schalter dafür findest du unter „HCP-Info“ im Abschnitt „Datenschutz und Impressum“. Schaltest du den Zähler aus, wird nichts mehr gesendet und die Kennung auf deinem Gerät gelöscht. Schaltest du ihn später wieder ein, entsteht eine neue Kennung, die sich der alten nicht zuordnen lässt. Bereits gezählte Tage bleiben als anonymer Eintrag ohne Bezug zu dir erhalten.</LegalP>
        <LegalP>{`Die Zähleinträge werden spätestens ${USAGE_ID_RETENTION_DAYS} Tage nach dem jeweiligen Tag automatisch gelöscht. Da die App auch offline funktioniert, kann ein Ping nachträglich gesendet werden, sobald wieder eine Verbindung besteht – auch dann wird nur der Kalendertag vermerkt.`}</LegalP>
      </LegalCard>

      <LegalCard title="5. PDF-Import, Export und Backup">
        <LegalP>Beim Import eines golf.de-Scoring-Records wird die PDF-Datei mit der Bibliothek pdf.js direkt in deinem Browser gelesen und ausgewertet. Die Datei verlässt dein Gerät nicht, es findet kein Upload statt, und die Bibliothek wird mit der App ausgeliefert – nicht von einem fremden Server nachgeladen.</LegalP>
        <LegalP>Der Export im Bereich „Daten“ erzeugt eine JSON-Datei, die dein Browser lokal speichert (üblicherweise im Download-Ordner). Was du anschließend mit dieser Datei machst – etwa in einer Cloud ablegen –, liegt in deiner Verantwortung.</LegalP>
      </LegalCard>

      <LegalCard title="6. Hosting und Server-Logfiles">
        <LegalP>Die App wird als statische Webseite bereitgestellt durch {LEGAL.hosting.provider}, {LEGAL.hosting.address}.</LegalP>
        <LegalP>Beim Abruf überträgt dein Browser technisch notwendige Daten, die der Hosting-Anbieter in Server-Logfiles verarbeitet: IP-Adresse, Datum und Uhrzeit des Zugriffs, abgerufene Datei, übertragene Datenmenge, Referrer und Browser- bzw. Gerätekennung (User-Agent).</LegalP>
        <LegalP>Zweck ist die technische Bereitstellung, Stabilität und Sicherheit des Angebots. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO; das berechtigte Interesse liegt im störungsfreien und sicheren Betrieb. Diese Logdaten werden vom Betreiber nicht personenbezogen ausgewertet und nicht mit deinen lokal gespeicherten Runden zusammengeführt; die Löschung richtet sich nach den Fristen des Anbieters. Der Anbieter wird dabei als Auftragsverarbeiter nach Art. 28 DSGVO auf Grundlage seines Data Processing Addendum tätig.</LegalP>
        <LegalP>Der Anbieter sitzt in den USA und liefert die Inhalte über ein weltweites Content-Delivery-Netzwerk aus; damit ist eine Übermittlung in die USA verbunden. {LEGAL.hosting.provider} ist nach dem EU-U.S. Data Privacy Framework zertifiziert, sodass sich die Übermittlung auf den Angemessenheitsbeschluss der EU-Kommission (Art. 45 DSGVO) stützt, ergänzend auf EU-Standarddatenschutzklauseln (Art. 46 Abs. 2 lit. c DSGVO).</LegalP>
        <LegalP>Beim selben Anbieter liegen auch die Einträge des Nutzungszählers (Abschnitt 4), also je Eintrag eine zufällige Kennung und ein Kalendertag. Ein zusätzlicher Dienstleister kommt dadurch nicht hinzu.</LegalP>
        <div style={{fontSize:14,lineHeight:1.8}}>
          Datenschutzhinweise des Hosting-Anbieters:{" "}
          <a href={LEGAL.hosting.privacyUrl} target="_blank" rel="noreferrer" style={legalLinkStyle}>{LEGAL.hosting.privacyLabel}</a>
        </div>
      </LegalCard>

      <LegalCard title="7. Externe Links und Installation als App">
        <LegalP>Die App verlinkt auf GitHub (Repository und Fehlermeldungen). Diese Links öffnest du bewusst; erst dann werden Daten an GitHub übertragen, wofür die Datenschutzhinweise von GitHub Inc. gelten. Eingebettete Inhalte von GitHub oder anderen Diensten gibt es nicht.</LegalP>
        <LegalP>Installierst du die App über die Funktion deines Browsers oder Betriebssystems auf dem Startbildschirm, entstehen dadurch keine zusätzlichen Datenübermittlungen an den Betreiber. Die installierte Version verhält sich wie die Webseite.</LegalP>
      </LegalCard>

      <LegalCard title="8. Keine Weitergabe, kein Profiling">
        <LegalP>Es findet keine Weitergabe von Daten an Dritte zu eigenen Zwecken statt. Übermittlungen in Drittländer außerhalb der EU/des EWR beschränken sich auf das, was durch das Hosting (Abschnitt 6) und von dir selbst geöffnete Links (Abschnitt 7) technisch bedingt ist. Es gibt keine automatisierte Entscheidungsfindung und kein Profiling im Sinne von Art. 22 DSGVO.</LegalP>
      </LegalCard>

      <LegalCard title="9. Speicherdauer und Löschung">
        <LegalP>Deine Einträge bleiben so lange gespeichert, bis du sie löschst. Einzelne Runden entfernst du in der Rundenliste. Vollständig löschst du alle Daten, indem du in den Einstellungen deines Browsers die Website-Daten für diese App löschst; bei einer installierten App genügt in der Regel das Deinstallieren. Auch der Offline-Cache des Service Workers wird dabei entfernt.</LegalP>
        <LegalP>Ein Backup vor dem Löschen erstellst du im Bereich „Daten“ über den JSON-Export.</LegalP>
        <LegalP>{`Unabhängig davon werden die Einträge des Nutzungszählers (Abschnitt 4) spätestens nach ${USAGE_ID_RETENTION_DAYS} Tagen automatisch gelöscht. Die Kennung auf deinem Gerät entfernst du sofort, indem du den Zähler ausschaltest.`}</LegalP>
      </LegalCard>

      <LegalCard title="10. Deine Rechte">
        <LegalP>Du hast nach der DSGVO das Recht auf Auskunft (Art. 15), Berichtigung (Art. 16), Löschung (Art. 17), Einschränkung der Verarbeitung (Art. 18), Datenübertragbarkeit (Art. 20) und Widerspruch gegen Verarbeitungen auf Grundlage berechtigter Interessen (Art. 21). Außerdem kannst du dich bei einer Datenschutz-Aufsichtsbehörde beschweren – zuständig ist die Behörde deines Wohnsitz-Bundeslandes oder die des Betreibers.</LegalP>
        <LegalP>Praktischer Hinweis: Zu deinen lokal gespeicherten Runden kann der Betreiber keine Auskunft erteilen und sie auch nicht löschen, weil er keinen Zugriff darauf hat. Diese Daten hast du selbst vollständig in der Hand – Auskunft und Datenübertragbarkeit erfüllt der JSON-Export im Bereich „Daten“. Für Anfragen zu den Server-Logfiles und zum Nutzungszähler genügt eine E-Mail an die in Abschnitt 1 genannte Adresse.</LegalP>
      </LegalCard>

      <LegalCard title="11. Stand und Änderungen">
        <LegalP>Stand dieser Datenschutzerklärung: {formatLegalDate(LEGAL.updatedAt)}. Ändern sich Funktionen, Hosting oder Datenflüsse der App, wird diese Erklärung entsprechend angepasst.</LegalP>
      </LegalCard>
    </div>
  );
}

function LegalPage({page, onOpenLegal, onBack, backLabel="Zurück"}) {
  const other = page==="impressum" ? "datenschutz" : "impressum";
  const switchButtonStyle: CSSProperties = { padding:"8px 14px", borderRadius:"var(--border-radius-md)", border:"1px solid var(--color-border-tertiary)", background:"rgba(255,255,255,0.92)", color:"var(--color-text-primary)", fontFamily:"var(--font-sans)", fontSize:13, fontWeight:600, cursor:"pointer" };

  return (
    <div>
      <div style={{...cardStyle,padding:"18px 20px",marginBottom:14,display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:14,flexWrap:"wrap"}}>
        <div>
          <div style={{fontSize:11,fontWeight:700,letterSpacing:"0.14em",textTransform:"uppercase",color:"#1D9E75",marginBottom:6}}>Rechtliches</div>
          <h1 style={{fontSize:22,fontWeight:600,margin:"0 0 4px"}}>{LEGAL_VIEW_LABELS[page]}</h1>
          <div style={{fontSize:13,color:"var(--color-text-secondary)"}}>Stand: {formatLegalDate(LEGAL.updatedAt)}</div>
        </div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginLeft:"auto"}}>
          <button onClick={()=>onOpenLegal(other)} style={switchButtonStyle}>{LEGAL_VIEW_LABELS[other]}</button>
          <button onClick={onBack} style={{...switchButtonStyle,background:"#F5F4F0"}}>{backLabel}</button>
        </div>
      </div>

      {page==="impressum" ? <Impressum/> : <Datenschutz/>}
    </div>
  );
}

function LegalStandalonePage({page, onOpenLegal, onBack}) {
  return (
    <div style={{maxWidth:760,margin:"0 auto",padding:appShellPadding,fontFamily:"var(--font-sans)",color:"var(--color-text-primary)",boxSizing:"border-box",width:"100%"}}>
      <LegalPage page={page} onOpenLegal={onOpenLegal} onBack={onBack} backLabel="Zur Startseite"/>
      <AppFooter onOpenLegal={onOpenLegal}/>
    </div>
  );
}

function AppFooter({onOpenLegal}) {
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
          <div style={{fontSize:12,fontWeight:700,letterSpacing:"0.12em",textTransform:"uppercase",color:"#1D9E75",marginBottom:8}}>Wolf Golf Club</div>
          <div style={{fontSize:13,color:"var(--color-text-secondary)",lineHeight:1.6}}>
            Golf mit Freunden: fuenf Spielformate im Flight, dazu der Handicap-Index nach WHS, damit die Vorgabe stimmt. Alles lokal im Browser.
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
          <div style={{fontSize:13,lineHeight:1.8}}>
            <button type="button" onClick={()=>onOpenLegal("impressum")} style={legalLinkButtonStyle}>Impressum</button>
          </div>
          <div style={{fontSize:13,lineHeight:1.8}}>
            <button type="button" onClick={()=>onOpenLegal("datenschutz")} style={legalLinkButtonStyle}>Datenschutzerklärung</button>
          </div>
          <div style={{fontSize:12,color:"var(--color-text-secondary)",lineHeight:1.6,marginTop:8}}>
            Kostenloses, nicht-kommerzielles Projekt. Runden und Profildaten bleiben lokal im Browser: kein Login, keine Analyse-Werkzeuge. Übertragen wird nur eine anonyme ID für den Nutzungszähler, abschaltbar in der Datenschutzerklärung.
          </div>
        </div>
      </div>
      <div style={{marginTop:16,paddingTop:14,borderTop:"1px solid var(--color-border-tertiary)",display:"flex",justifyContent:"space-between",gap:12,flexWrap:"wrap",fontSize:12,color:"var(--color-text-secondary)"}}>
        <span>{year} Wolf Golf Club</span>
        <span>Feedback und Fehlermeldungen laufen ueber GitHub Issues.</span>
      </div>
    </footer>
  );
}

// Die Startseite verkauft zuerst das Spiel mit Freunden. Der Handicap-Index ist
// das Feature darunter: nur mit aktueller Vorgabe ist ein Netto-Match fair und
// die Spielerkarte hinter dem QR-Code brauchbar. Deshalb steht oben ein Aufmacher
// mit Slider über beide Seiten, alles Weitere haengt an der Rubriken-Navigation
// statt an einer langen Scroll-Strecke.
const LANDING_SLIDES = [
  {
    id: "spiel",
    tab: "Mit Freunden spielen",
    eyebrow: "Darum geht es",
    lead: "Matchplay, Nassau mit Press, Skins mit Carry-over, Wolf und Bingo Bango Bongo – gleichzeitig auf denselben Schlägen, Loch für Loch mitgezählt.",
    highlights: [
      "Fünf Spielformate parallel auf einer Runde",
      "Mitspieler per QR-Code eingeladen, ohne Abtippen",
      "Am Ende eine Abrechnung, über die niemand diskutiert",
    ],
  },
  {
    id: "index",
    tab: "Handicap immer aktuell",
    eyebrow: "Das Feature darunter",
    lead: "Damit die Vorgabe stimmt, wenn es zählt: Nach jeder Runde steht dein neuer Index – erklärt, nicht nur ausgerechnet.",
    highlights: [
      "Neuer Index sofort nach der Runde",
      "Auf der Spielerkarte im QR-Code steht ein aktueller Wert",
      "golf.de-Historie per PDF importiert",
    ],
  },
];

const LANDING_CHAIN = ["Index ist aktuell", "Vorgabe stimmt", "Netto-Match ist fair"];

const LANDING_GAME_POINTS = [
  ["Fünf Spielformate", "Matchplay, Nassau mit Press, Skins mit Carry-over, Wolf und Bingo Bango Bongo – gleichzeitig auf denselben Scores."],
  ["Per QR-Code eingeladen", "Mitspieler zeigen ihre Spielerkarte, du scannst sie mit der Kamera – Name und aktueller Index sind da, ohne Abtippen. Auch der Platz samt Scorekarte und das ganze Spiel-Setup wandern so von Gerät zu Gerät."],
  ["Netto mit der richtigen Vorgabe", "Weil dein Index stimmt, stimmt auch die Vorgabe: Der 28er hat gegen den 12er eine echte Chance statt einer rechnerischen."],
  ["Abrechnung in Punkten", "Die App zählt Punkte und verrechnet sie auf möglichst wenige Ausgleiche. Was ein Punkt wert ist, macht der Flight unter sich aus."],
  ["Jeder schreibt mit, alle vergleichen", "Teilt das Spiel, dann läuft es auf jedem Telefon mit identischem Setup. Am Ende haltet ihr die Abrechnungen nebeneinander – Tippfehler fallen sofort auf."],
  ["Aus dem Spiel wird eine Runde", "Am Ende übernimmst du dein Ergebnis mit einem Klick als HCP-wirksame Runde."],
];

const LANDING_INDEX_POINTS = [
  ["Neuer Index sofort", "Runde eintragen, Index steht. Kein Warten, bis der Club die Scorekarte verarbeitet hat und golf.de nachzieht."],
  ["Jede Formel erklärt", "Score Differenzial, Wertungsfenster, Exceptional Score, Anfänger-Bremse – mit Formel und Beispiel, auch wenn du mit WHS noch nie zu tun hattest."],
  ["Du siehst, was zählt", "Welche Runden gerade zählen, welche als nächste aus dem Fenster fällt, und warum eine gute Runde manchmal nichts ändert."],
  ["Historie in einem Schritt", "Den detaillierten Scoring Record von golf.de als PDF importieren – chronologisch, ohne Abtippen, ohne Upload."],
];

const LANDING_DETAILS = [
  {
    title: "Exceptional Score (Regel 5.9)",
    text: "Liegt ein Differenzial 7,0 bis 9,9 Schläge unter deinem Index, sinken alle aktuellen Differenziale um 1,0 – ab 10,0 Schlägen um 2,0. Die App verarbeitet Runden chronologisch, damit die Reduktion zum richtigen Zeitpunkt greift. Auch beim Import.",
  },
  {
    title: "Die DGV-Bremse für Anfänger",
    text: "Über einem Index von 26,9 geht es nur nach unten: Ein erspielter Wert wird nicht wieder angehoben, auch wenn danach schwächere Runden folgen. Erst darunter bewegt sich der Index in beide Richtungen.",
  },
  {
    title: "9-Loch-Runden ergänzt statt verdoppelt",
    text: "Das tatsächliche 9-Loch-Differenzial wird um den erwarteten Wert für die zweiten neun Löcher ergänzt, abgeleitet aus deinem aktuellen Index – nicht einfach mit zwei multipliziert. Wie genau, steht in der HCP-Info.",
  },
  {
    title: "Course Rating und Slope pro Abschlag",
    text: "Jeder Platz wird mit CR, Slope, Par und Tee hinterlegt. Damit stimmt das Differenzial auch dann, wenn du zwischen Plätzen und Abschlägen wechselst.",
  },
];

const LANDING_FAQ = [
  {
    q: "Spielen wir damit um Geld?",
    a: "Das entscheidet ihr, nicht die App. Sie zählt ausschließlich Punkte und rechnet nichts in Geld um – was ein Punkt am Ende wert ist, vereinbart ihr im Flight. Es fließt kein Geld über die App, sie verwahrt und überweist nichts.",
  },
  {
    q: "Ist das mein offizielles Handicap?",
    a: "Nein. Die App rechnet nach den WHS-Regeln des DGV, verbindlich bleibt der Index, den dein Heimatclub führt. Der Vorteil ist der Zeitpunkt: Du siehst den neuen Wert direkt nach der Runde, während der offizielle erst nach der Verarbeitung im Club bei golf.de erscheint. Der berechnete Wert entspricht dem, was golf.de später als „Berechneter HCPI“ ausweist.",
  },
  {
    q: "Ich fange gerade mit Golf an – hilft mir das?",
    a: "Dafür ist die App vor allem gedacht. Am Anfang bewegt sich der Index in Sprüngen, die von außen willkürlich wirken: die Anfänger-Bremse ab 26,9, die Anpassung bei wenigen Runden, Ausnahmerunden. Die App zeigt nach jeder Runde, welche dieser Regeln gegriffen hat – und im Bereich HCP-Info steht jede Formel mit Beispiel.",
  },
  {
    q: "Kann ich meine Historie aus golf.de übernehmen?",
    a: "Ja. Lade dort den detaillierten Scoring Record als PDF und importiere ihn. Die App liest die Runden direkt im Browser aus der Datei, inklusive der Reihenfolge, die für Exceptional Scores wichtig ist.",
  },
  {
    q: "Wo liegen meine Daten, und was kostet das?",
    a: "Die App ist kostenlos, ohne Werbung und ohne Konto. Runden, Plätze und Spiele liegen im Speicher deines Browsers auf deinem Gerät und werden nirgendwohin synchronisiert; ein JSON-Export im Bereich „Daten“ dient als Backup. Auch das Teilen per QR-Code läuft direkt von Gerät zu Gerät: Die Daten stecken hinter dem Rautezeichen des Links, und den Teil sendet ein Browser nie an einen Server. Übertragen wird lediglich eine zufällige Installations-ID für den anonymen Nutzungszähler – abschaltbar unter „HCP-Info“, Details in der Datenschutzerklärung.",
  },
];

const LANDING_PANELS = [
  { id:"starten", label:"Starten" },
  { id:"spiele", label:"Spiele" },
  { id:"handicap", label:"Handicap" },
  { id:"fragen", label:"Fragen" },
];

// Aufmacher-Bild: dieselbe Bildmarke wie im App-Icon (Fahne mit Wolfskopf),
// nur gross und auf den Platz gestellt. Die Fahne selbst kommt aus WolfFlagArt,
// damit die Geometrie an genau einer Stelle steht.
function HeroScene({ratio="4 / 3"}) {
  return (
    <div style={{
      width:"100%",aspectRatio:ratio,borderRadius:"var(--border-radius-lg)",overflow:"hidden",
      border:"1px solid rgba(255,255,255,0.16)",boxShadow:"0 18px 40px rgba(4,20,14,0.34)",
    }}>
      <svg viewBox="0 0 320 180" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" role="img" aria-label="Der Wolf-Golf-Wimpel auf dem Grün">
        <defs>
          <linearGradient id="hero-sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0A3F30"/>
            <stop offset="100%" stopColor="#1E8965"/>
          </linearGradient>
          <linearGradient id="hero-turf" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#33BE8E"/>
            <stop offset="100%" stopColor="#0F5C46"/>
          </linearGradient>
        </defs>
        <rect width="320" height="180" fill="url(#hero-sky)"/>
        <circle cx="268" cy="34" r="24" fill="#F7E3B6" opacity="0.2"/>
        {/* Fairway-Baender: zwei Kuppen, damit Tiefe entsteht */}
        <path d="M0 96 C 66 80, 122 104, 184 94 C 238 85, 286 98, 320 90 L 320 180 L 0 180 Z" fill="#12654E" opacity="0.85"/>
        <path d="M0 124 C 78 108, 146 134, 214 122 C 258 114, 294 124, 320 118 L 320 180 L 0 180 Z" fill="url(#hero-turf)"/>
        <ellipse cx="170" cy="152" rx="104" ry="24" fill="#3FCE9B" opacity="0.34"/>
        <ellipse cx="214" cy="150" rx="8" ry="3.4" fill="#07271D" opacity="0.9"/>
        <ellipse cx="150" cy="150" rx="14" ry="4" fill="#07271D" opacity="0.24"/>
        <g transform="translate(104 16) scale(1.62)">
          <WolfFlagArt/>
        </g>
        <circle cx="238" cy="146" r="6.5" fill="#fff"/>
        <circle cx="236" cy="144" r="4.6" fill="#EDF6F1" opacity="0.9"/>
      </svg>
    </div>
  );
}

function LandingPage({profile, onSave, onOpenLegal}) {
  // Der Desktop-Screenshot ist auf Telefonbreite nicht mehr lesbar, dort zeigen
  // die Rubriken die Mobilansicht.
  const showDesktopShot = useMediaQuery("(min-width: 760px)");
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [slide, setSlide] = useState(0);
  const [autoPlay, setAutoPlay] = useState(true);
  const [panel, setPanel] = useState("starten");
  const panelRef = useRef(null);
  const touchStartX = useRef(null);

  // Der Slider laeuft von allein, damit beide Seiten ohne Zutun zu sehen sind –
  // und haelt an, sobald jemand selbst blaettert.
  useEffect(()=>{
    if (!autoPlay || reduceMotion) return;
    const timer = setInterval(()=>setSlide(prev=>(prev+1)%LANDING_SLIDES.length), 7000);
    return ()=>clearInterval(timer);
  },[autoPlay, reduceMotion]);

  const showSlide = index => {
    setAutoPlay(false);
    setSlide((index+LANDING_SLIDES.length)%LANDING_SLIDES.length);
  };
  const onTouchStart = e => { touchStartX.current = e.touches[0]?.clientX ?? null; };
  const onTouchEnd = e => {
    if (touchStartX.current===null) return;
    const delta = (e.changedTouches[0]?.clientX ?? 0) - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(delta) < 44) return;
    showSlide(slide + (delta<0 ? 1 : -1));
  };
  const openPanel = id => {
    setPanel(id);
    requestAnimationFrame(()=>panelRef.current?.scrollIntoView({behavior:reduceMotion?"auto":"smooth", block:"start"}));
  };

  const primaryButtonStyle: CSSProperties = {
    padding:"13px 22px", borderRadius:"var(--border-radius-md)", border:"none",
    background:"#fff", color:"#0F3A2C", fontFamily:"var(--font-sans)", fontSize:15, fontWeight:700,
    cursor:"pointer", boxShadow:"0 10px 24px rgba(4,20,14,0.32)",
  };
  const secondaryButtonStyle: CSSProperties = {
    padding:"13px 22px", borderRadius:"var(--border-radius-md)",
    border:"1px solid rgba(255,255,255,0.34)", background:"rgba(255,255,255,0.1)", color:"#fff",
    fontFamily:"var(--font-sans)", fontSize:15, fontWeight:600, cursor:"pointer",
  };
  const greenButtonStyle: CSSProperties = {
    padding:"13px 22px", borderRadius:"var(--border-radius-md)", border:"none",
    background:"linear-gradient(135deg, #1D9E75 0%, #14684f 100%)", color:"#fff",
    fontFamily:"var(--font-sans)", fontSize:15, fontWeight:700, cursor:"pointer",
    boxShadow:"0 10px 22px rgba(6,52,38,0.28)",
  };
  const eyebrowStyle: CSSProperties = {
    fontSize:12, fontWeight:700, letterSpacing:"0.14em", textTransform:"uppercase",
    color:"#1D9E75", marginBottom:10,
  };
  const sectionHeadingStyle: CSSProperties = { fontSize:26, fontWeight:650, lineHeight:1.2, margin:"0 0 10px" };
  const bodyTextStyle: CSSProperties = { fontSize:15, lineHeight:1.65, color:"var(--color-text-secondary)", margin:0 };

  const check = (
    <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{flexShrink:0}}>
      <path d="M5 12.5l4.5 4.5L19 7"/>
    </svg>
  );

  const mobileShot = (maxWidth: number) => (
    <img
      src="/screenshot-mobile.jpg"
      width={390}
      height={780}
      loading="lazy"
      alt="Wolf Golf auf einem Smartphone: Handicap-Index, Kennzahlen und Wertungsfenster"
      style={{display:"block",width:"100%",maxWidth,height:"auto",borderRadius:22,border:"1px solid var(--color-border-tertiary)",boxShadow:"0 18px 42px rgba(8,28,20,0.22)"}}
    />
  );

  const pointList = points => (
    <div style={{display:"grid",gap:12}}>
      {points.map(([title, text])=>(
        <div key={title} style={{display:"flex",gap:11,alignItems:"flex-start"}}>
          <span style={{color:"#1D9E75",marginTop:3}}>{check}</span>
          <div>
            <div style={{fontSize:15,fontWeight:650,marginBottom:2}}>{title}</div>
            <div style={{fontSize:14,lineHeight:1.6,color:"var(--color-text-secondary)"}}>{text}</div>
          </div>
        </div>
      ))}
    </div>
  );

  const panels = {
    starten: (
      <div style={{...cardStyle,padding:"clamp(22px, 3vw, 32px)",display:"flex",gap:28,flexWrap:"wrap"}}>
        <div style={{flex:"1 1 300px",minWidth:0}}>
          <div style={eyebrowStyle}>Jetzt starten</div>
          <h2 style={sectionHeadingStyle}>In 30 Sekunden startklar.</h2>
          <p style={{...bodyTextStyle,marginBottom:14}}>
            Name und Start-HCP – mehr braucht die App nicht. Wenn du dein Handicap nicht kennst, lass die 54 stehen:
            Sie ist der WHS-Startwert und wird mit deinen ersten Runden automatisch besser.
          </p>
          <div style={{display:"grid",gap:8}}>
            {["Kein Konto, keine E-Mail-Adresse, kein Passwort","Alles bleibt auf diesem Gerät gespeichert","Historie aus golf.de kannst du direkt danach importieren"].map(text=>(
              <div key={text} style={{display:"flex",gap:9,alignItems:"flex-start",fontSize:14,lineHeight:1.6,color:"var(--color-text-secondary)"}}>
                <span style={{color:"#1D9E75",marginTop:3}}>{check}</span>
                <span>{text}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={{flex:"1 1 300px",minWidth:"min(100%, 300px)"}}>
          <ProfileForm profile={profile} onSave={onSave} isSetup/>
        </div>
      </div>
    ),
    spiele: (
      <div style={{...cardStyle,padding:"clamp(22px, 3vw, 32px)",display:"flex",gap:28,flexWrap:"wrap"}}>
        <div style={{flex:"1 1 340px",minWidth:0}}>
          <div style={eyebrowStyle}>Der Wettstreit im Flight</div>
          <h2 style={sectionHeadingStyle}>Aus einer Runde zu viert werden fünf Wettkämpfe.</h2>
          <p style={{...bodyTextStyle,marginBottom:16}}>
            Dieselben Schläge, mehrere Wetten parallel: Loch für Loch mitgezählt, am Ende eine Abrechnung, über die
            niemand diskutiert.
          </p>
          {pointList(LANDING_GAME_POINTS)}
        </div>
        {showDesktopShot && (
          <div style={{flex:"0 1 230px",display:"grid",placeItems:"start center",minWidth:0}}>{mobileShot(220)}</div>
        )}
      </div>
    ),
    handicap: (
      <div style={{display:"grid",gap:16}}>
        <div style={{...cardStyle,padding:"clamp(22px, 3vw, 32px)"}}>
          <div style={eyebrowStyle}>Das Feature unter den Spielen</div>
          <h2 style={sectionHeadingStyle}>Nach der Runde weißt du sofort, wo du stehst.</h2>
          <p style={{...bodyTextStyle,marginBottom:16}}>
            Dein Club führt den Index, sagt dir aber weder, warum er sich bewegt hat, noch wann. Wolf Golf schon – in
            dem Moment, in dem du die Runde einträgst. Und weil er stimmt, stimmt die Vorgabe im nächsten Match.
          </p>
          {pointList(LANDING_INDEX_POINTS)}
        </div>
        <div style={{...cardStyle,padding:"clamp(22px, 3vw, 32px)",background:"linear-gradient(160deg, rgba(20,46,37,0.97) 0%, rgba(18,57,44,0.95) 100%)",color:"#fff"}}>
          <div style={{...eyebrowStyle,color:"rgba(255,255,255,0.7)"}}>Das Regelwerk hinter der Zahl</div>
          <h2 style={{...sectionHeadingStyle,color:"#fff",maxWidth:640}}>WHS ist mehr als ein Mittelwert.</h2>
          <p style={{fontSize:15,lineHeight:1.65,color:"rgba(255,255,255,0.78)",margin:"0 0 20px",maxWidth:660}}>
            Ein Durchschnitt über die besten Runden ist schnell erklärt. Die Regeln, die deinen Index tatsächlich
            bewegen, stecken in den Sonderfällen – und die sind der Grund, warum das Handicap besonders am Anfang
            unübersichtlich wirkt. Wolf Golf rechnet sie mit und schreibt dazu, was passiert ist.
          </p>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(270px, 1fr))",gap:14,marginBottom:18}}>
            {LANDING_DETAILS.map(detail=>(
              <div key={detail.title} style={{padding:"16px 18px",borderRadius:"var(--border-radius-md)",background:"rgba(255,255,255,0.09)",border:"1px solid rgba(255,255,255,0.14)"}}>
                <div style={{display:"flex",gap:9,alignItems:"center",marginBottom:7}}>
                  <span style={{color:"#7BE0B4",display:"grid",placeItems:"center"}}>{check}</span>
                  <span style={{fontSize:16,fontWeight:650}}>{detail.title}</span>
                </div>
                <div style={{fontSize:14,lineHeight:1.6,color:"rgba(255,255,255,0.78)"}}>{detail.text}</div>
              </div>
            ))}
          </div>
          <div style={{padding:"14px 16px",borderRadius:"var(--border-radius-md)",background:"rgba(0,0,0,0.22)",border:"1px solid rgba(255,255,255,0.12)",fontSize:14,lineHeight:1.65,color:"rgba(255,255,255,0.8)"}}>
            <strong style={{color:"#fff",fontWeight:650}}>Und was die App nicht kann:</strong> Die tagesbezogene
            Platzverhältnis-Korrektur (PCC) rechnet sie mit 0, weil sie die Tageswerte nicht kennt. Verbindlich bleibt
            immer der Index, den dein Club über den DGV führt – die App ist dein Zweitblick darauf, keine Ersatz-Verwaltung.
          </div>
        </div>
        {showDesktopShot && (
          <figure style={{margin:0}}>
            <div style={{...cardStyle,overflow:"hidden",padding:0}}>
              <div style={{display:"flex",alignItems:"center",gap:8,padding:"10px 14px",background:"linear-gradient(180deg, rgba(24,44,36,0.96) 0%, rgba(17,34,28,0.96) 100%)"}}>
                {["#E8695F","#E8B85F","#63C08A"].map(color=>(
                  <span key={color} style={{width:10,height:10,borderRadius:999,background:color,flexShrink:0}}/>
                ))}
                <span style={{marginLeft:8,padding:"3px 12px",borderRadius:999,background:"rgba(255,255,255,0.1)",color:"rgba(255,255,255,0.68)",fontSize:12,fontWeight:600}}>
                  {LEGAL.site.domain}
                </span>
              </div>
              <img
                src="/screenshot-dashboard.jpg"
                width={1440}
                height={990}
                loading="lazy"
                alt="Dashboard von Wolf Golf mit Wertungsfenster, Score Differenzialen und HCP-Verlauf"
                style={{display:"block",width:"100%",height:"auto"}}
              />
            </div>
            <figcaption style={{fontSize:13,color:"var(--color-text-secondary)",marginTop:10,textAlign:"center"}}>
              Dashboard mit Beispieldaten: aktueller Index, Wertungsfenster und Verlauf auf einen Blick.
            </figcaption>
          </figure>
        )}
      </div>
    ),
    fragen: (
      <div style={{...cardStyle,padding:"clamp(22px, 3vw, 32px)"}}>
        <div style={eyebrowStyle}>Häufige Fragen</div>
        <h2 style={{...sectionHeadingStyle,marginBottom:14}}>Kurz beantwortet.</h2>
        <div style={{display:"grid",gap:10}}>
          {LANDING_FAQ.map(item=>(
            <details key={item.q} style={{...subtleCardStyle,padding:"14px 18px"}}>
              <summary className="faq-summary" style={{fontSize:16,fontWeight:600,cursor:"pointer",listStyle:"none"}}>{item.q}</summary>
              <div style={{fontSize:14,lineHeight:1.7,color:"var(--color-text-secondary)",marginTop:10}}>{item.a}</div>
            </details>
          ))}
        </div>
      </div>
    ),
  };

  const slideDeck = (
    // Kein Eckenradius am Rahmen: der wuerde zusammen mit overflow:hidden den
    // ersten Buchstaben der Folie anschneiden.
    <div
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      style={{overflow:"hidden",marginBottom:18}}>
      <div style={{
        display:"flex",width:`${LANDING_SLIDES.length*100}%`,
        transform:`translateX(-${slide * (100/LANDING_SLIDES.length)}%)`,
        transition:reduceMotion?"none":"transform 420ms cubic-bezier(0.22,0.61,0.36,1)",
      }}>
        {LANDING_SLIDES.map((item, index)=>(
          <div
            key={item.id}
            role="tabpanel"
            id={`hero-panel-${item.id}`}
            aria-labelledby={`hero-tab-${item.id}`}
            aria-hidden={slide!==index}
            style={{width:`${100/LANDING_SLIDES.length}%`,flexShrink:0,boxSizing:"border-box",paddingRight:2}}>
            <div style={{fontSize:11,fontWeight:700,letterSpacing:"0.14em",textTransform:"uppercase",color:"rgba(255,255,255,0.6)",marginBottom:8}}>{item.eyebrow}</div>
            <p style={{fontSize:"clamp(15px, 1.9vw, 17px)",lineHeight:1.6,color:"rgba(255,255,255,0.86)",margin:"0 0 14px"}}>{item.lead}</p>
            <div style={{display:"grid",gap:7}}>
              {item.highlights.map(text=>(
                <div key={text} style={{display:"flex",gap:9,alignItems:"flex-start",fontSize:14,lineHeight:1.5,color:"rgba(255,255,255,0.92)"}}>
                  <span style={{color:"#7BE0B4",marginTop:2}}>{check}</span>
                  <span>{text}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div style={{maxWidth:1080,margin:"0 auto",padding:appShellPadding,fontFamily:"var(--font-sans)",color:"var(--color-text-primary)",boxSizing:"border-box",width:"100%"}}>
      <header style={{display:"flex",alignItems:"center",gap:12,marginBottom:14,flexWrap:"wrap"}}>
        <BrandMark size={38}/>
        <div style={{minWidth:0}}>
          <div style={{fontSize:16,fontWeight:650,lineHeight:1.2}}>Wolf Golf Club</div>
          <div style={{fontSize:12,color:"var(--color-text-secondary)"}}>Spielt gegeneinander. Mit der richtigen Vorgabe.</div>
        </div>
        <nav aria-label="Bereiche" style={{display:"flex",gap:6,flexWrap:"wrap",marginLeft:"auto",alignItems:"center"}}>
          {LANDING_PANELS.map(item=>(
            <button
              key={item.id}
              type="button"
              aria-current={panel===item.id ? "true" : undefined}
              onClick={()=>openPanel(item.id)}
              style={{
                padding:"8px 14px",borderRadius:999,cursor:"pointer",fontFamily:"var(--font-sans)",fontSize:13,
                fontWeight:panel===item.id?700:600,
                border:`1px solid ${panel===item.id?"transparent":"var(--color-border-tertiary)"}`,
                background:panel===item.id?"linear-gradient(135deg, #1D9E75 0%, #14684f 100%)":"rgba(255,255,255,0.72)",
                color:panel===item.id?"#fff":"var(--color-text-secondary)",
              }}>
              {item.label}
            </button>
          ))}
        </nav>
      </header>

      <section style={{...cardStyle,padding:"clamp(22px, 3.4vw, 36px)",marginBottom:18,background:"linear-gradient(145deg, rgba(16,42,33,0.98) 0%, rgba(18,57,44,0.96) 46%, rgba(29,158,117,0.84) 100%)",color:"#fff",position:"relative",overflow:"hidden"}}>
        <div style={{position:"absolute",inset:0,background:"radial-gradient(circle at 84% 12%, rgba(255,255,255,0.2), transparent 26%), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)",backgroundSize:"auto, 28px 28px",opacity:0.32,pointerEvents:"none"}}/>
        <div style={{position:"relative",display:"flex",gap:"clamp(20px, 3vw, 34px)",flexWrap:"wrap",alignItems:"flex-start"}}>
          <div style={{flex:"1 1 380px",minWidth:0}}>
            <div style={{...eyebrowStyle,color:"rgba(255,255,255,0.68)"}}>Wolf Golf Club</div>
            <h1 style={{fontSize:"clamp(29px, 4.6vw, 44px)",lineHeight:1.06,fontWeight:700,margin:"0 0 12px"}}>
              Spielt gegeneinander. Golf wird lustiger als je zuvor.
            </h1>
            {!showDesktopShot && <div style={{margin:"0 0 16px"}}><HeroScene ratio="16 / 9"/></div>}

            {/* Grid statt inline-flex: ein baseline-ausgerichteter inline-flex-Kasten
                laeuft aus seiner Zeile heraus und schiebt sich ueber den Folientext. */}
            <div role="tablist" aria-label="Beide Seiten" style={{display:"grid",gridTemplateColumns:`repeat(${LANDING_SLIDES.length}, minmax(0, 1fr))`,gap:4,padding:4,marginBottom:14,borderRadius:999,background:"rgba(255,255,255,0.12)",border:"1px solid rgba(255,255,255,0.18)",width:showDesktopShot?"fit-content":"100%",maxWidth:"100%",boxSizing:"border-box"}}>
              {LANDING_SLIDES.map((item, index)=>(
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  id={`hero-tab-${item.id}`}
                  aria-selected={slide===index}
                  aria-controls={`hero-panel-${item.id}`}
                  onClick={()=>showSlide(index)}
                  style={{
                    padding:"9px 16px",borderRadius:999,border:"none",cursor:"pointer",fontFamily:"var(--font-sans)",
                    fontSize:13.5,fontWeight:slide===index?700:600,
                    background:slide===index?"#fff":"transparent",
                    color:slide===index?"#0F3A2C":"rgba(255,255,255,0.82)",
                    transition:reduceMotion?"none":"background 220ms ease, color 220ms ease",
                  }}>
                  {item.tab}
                </button>
              ))}
            </div>

            {slideDeck}

            {/* Beide Seiten in einer Zeile zusammengebunden – bleibt stehen, egal
                welche Folie laeuft, und bricht ohne einzelne Pfeile am Zeilenanfang. */}
            <div style={{borderLeft:"2px solid rgba(123,224,180,0.7)",paddingLeft:12,marginBottom:18,fontSize:13.5,lineHeight:1.6,color:"rgba(255,255,255,0.74)"}}>
              {LANDING_CHAIN.map((text, index)=>(
                <span key={text}>
                  {index>0 && <span aria-hidden="true" style={{padding:"0 6px"}}>→</span>}
                  <strong style={{color:"#fff",fontWeight:650}}>{text}</strong>
                </span>
              ))}
            </div>

            <div style={{display:"flex",gap:12,flexWrap:"wrap",marginBottom:12}}>
              {/* Auf dem Telefon teilen sich beide Knoepfe eine Zeile statt untereinander zu stapeln. */}
              <button type="button" onClick={()=>openPanel("starten")} style={{...primaryButtonStyle,flex:showDesktopShot?"0 0 auto":"1 1 150px"}}>Kostenlos starten</button>
              <button type="button" onClick={()=>openPanel("spiele")} style={{...secondaryButtonStyle,flex:showDesktopShot?"0 0 auto":"1 1 150px"}}>Alle Spielformate</button>
            </div>
            <div style={{fontSize:12.5,color:"rgba(255,255,255,0.66)"}}>
              0 €, ohne Konto · läuft offline auf der Runde · Daten bleiben auf deinem Gerät
            </div>
          </div>

          {showDesktopShot && (
            <div style={{flex:"0 1 340px",minWidth:0,alignSelf:"stretch",display:"grid",gap:12,alignContent:"start"}}>
              <HeroScene ratio="4 / 3"/>
              <div style={{display:"flex",gap:8,justifyContent:"center"}}>
                {LANDING_SLIDES.map((item, index)=>(
                  <button
                    key={item.id}
                    type="button"
                    aria-label={`Folie: ${item.tab}`}
                    aria-current={slide===index ? "true" : undefined}
                    onClick={()=>showSlide(index)}
                    style={{width:slide===index?26:9,height:9,padding:0,borderRadius:999,border:"none",cursor:"pointer",background:slide===index?"#fff":"rgba(255,255,255,0.34)",transition:reduceMotion?"none":"width 220ms ease, background 220ms ease"}}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        {!showDesktopShot && (
          <div style={{position:"relative",display:"flex",gap:8,justifyContent:"center",marginTop:16}}>
            {LANDING_SLIDES.map((item, index)=>(
              <button
                key={item.id}
                type="button"
                aria-label={`Folie: ${item.tab}`}
                aria-current={slide===index ? "true" : undefined}
                onClick={()=>showSlide(index)}
                style={{width:slide===index?26:9,height:9,padding:0,borderRadius:999,border:"none",cursor:"pointer",background:slide===index?"#fff":"rgba(255,255,255,0.34)",transition:reduceMotion?"none":"width 220ms ease, background 220ms ease"}}
              />
            ))}
          </div>
        )}
      </section>

      <div ref={panelRef} style={{scrollMarginTop:14,marginBottom:22}}>
        {panels[panel]}
      </div>

      <AppFooter onOpenLegal={onOpenLegal}/>
    </div>
  );
}


const SIDEBAR_WIDTH = 248;
const SIDEBAR_WIDTH_COLLAPSED = 76;
const NAV_COLLAPSED_KEY = "golf_hcp_nav_collapsed";
const DESKTOP_QUERY = "(min-width: 1024px)";
const NAV_ITEMS = [
  { id:"dashboard", label:"Dashboard", icon:["M4 13h6V4H4v9Z","M14 20h6v-9h-6v9Z","M4 20h6v-4H4v4Z","M14 8h6V4h-6v4Z"] },
  { id:"games", label:"Games", icon:["M7.5 4h9v4.5a4.5 4.5 0 01-9 0V4Z","M7.5 5.5H4.5v1A3.5 3.5 0 008 10","M16.5 5.5h3v1A3.5 3.5 0 0116 10","M12 13v3.5","M8.5 20h7"] },
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

// Der Inhalt der Bildmarke in ihren eigenen 64x64-Koordinaten. Icon und
// Aufmacher-Szene setzen beide darauf auf, damit die Zahlen nur hier stehen.
function WolfFlagArt() {
  return (
    <g transform="translate(-11.26 -0.71) scale(1.34)">
      <line x1="15.5" y1="8.5" x2="15.5" y2="42.3" stroke="#fff" strokeWidth={3} strokeLinecap="round"/>
      <path d={WOLF_FLAG_PATH} fill="#fff"/>
      <g transform="translate(19.898 12.748) scale(0.255)">
        <path d={WOLF_HEAD_PATH} fill={WOLF_DARK}/>
        <path d={WOLF_EYE_PATH} fill="#fff"/>
        <path d={WOLF_EAR_PATH} fill="#fff"/>
      </g>
    </g>
  );
}

function WolfFlagMark({size=34}) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" style={{flexShrink:0,display:"block"}}>
      <WolfFlagArt/>
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

function SideNav({view, onSelect, isDesktop, collapsed, onToggleCollapsed, open, onClose, profileName, displayHcp, simulated=false}) {
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
          {showLabels && <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.14em",textTransform:"uppercase",color:"rgba(255,255,255,0.55)",marginBottom:4}}>{simulated?"HCP Index · Szenario":"HCP Index"}</div>}
          <div style={{fontSize:showLabels?24:15,fontWeight:700,lineHeight:1.1,color:simulated?"#F5AC63":"#fff"}}>{displayHcp}</div>
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

function MobileTopBar({title, displayHcp, onOpenNav, maxWidth, simulated=false}) {
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
          <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.12em",textTransform:"uppercase",color:"var(--color-text-secondary)"}}>{simulated?"HCP · Szenario":"HCP"}</div>
          <div style={{fontSize:18,fontWeight:700,color:simulated?"#C56B1A":COLORS.hcp,lineHeight:1.1}}>{displayHcp}</div>
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
  // Geteilte Spieler- und Platzkarten kommen als Link mit Nutzlast im Fragment an.
  const [pendingCard, setPendingCard] = useState<ShareCard | null>(null);

  useEffect(()=>saveDB(db),[db]);

  useEffect(()=>{
    const read = () => {
      const card = parseShareHash(window.location.hash);
      if (card) setPendingCard(card);
    };
    read();
    window.addEventListener("hashchange", read);
    return ()=>window.removeEventListener("hashchange", read);
  },[]);

  // Nach Uebernahme oder Abbruch muss das Fragment weg, sonst taucht der Dialog
  // beim naechsten Laden wieder auf.
  const dismissCard = () => {
    setPendingCard(null);
    if (window.location.hash) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  };

  const acceptCard = (card: ShareCard) => {
    if (card.kind === "player") {
      updateDB(db=>{
        const players = [...db.players];
        const index = players.findIndex(p=>!p.isMe && p.name.toLowerCase() === card.name.toLowerCase());
        if (index >= 0) players[index] = {...players[index], hcpIndex: card.hcpIndex};
        else { players.push({id: db.nextPlayerId, name: card.name, hcpIndex: card.hcpIndex, isMe: false}); db.nextPlayerId += 1; }
        db.players = players;
        return db;
      });
    } else if (card.kind === "course") {
      updateDB(db=>{
        const courses = [...db.courses];
        const patch = {
          name: card.name,
          courseRating: card.courseRating,
          slopeRating: card.slopeRating,
          par: card.par,
          tee: card.tee || "Gelb",
          ...(card.holeCount ? {holeCount: card.holeCount} : {}),
          ...(card.holeData ? {holeData: card.holeData} : {}),
        };
        const index = courses.findIndex(c=>c.name.toLowerCase() === card.name.toLowerCase() && (c.tee || "") === (card.tee || c.tee || ""));
        if (index >= 0) courses[index] = {...courses[index], ...patch};
        else { courses.push({...patch, notes: "", nineHolePhcpFactor: 0.5, id: db.nextCourseId}); db.nextCourseId += 1; }
        db.courses = courses;
        return db;
      });
    } else {
      acceptGameCard(card);
    }
    dismissCard();
  };

  /**
   * Uebernimmt ein geteiltes Spiel. Platz und Mitspieler werden bei Bedarf
   * angelegt, danach entsteht dasselbe Spiel wie auf dem Geraet des Gastgebers:
   * Course Handicaps und Vorgabenverteilung rechnet dieses Geraet aus denselben
   * Eingaben selbst nach, damit die Abrechnungen am Ende vergleichbar sind.
   */
  const acceptGameCard = (card: GameCard) => {
    updateDB(db=>{
      const courses = [...db.courses];
      const courseIndex = courses.findIndex(c=>c.name.toLowerCase() === card.course.name.toLowerCase());
      const coursePatch = {
        name: card.course.name,
        courseRating: card.course.courseRating,
        slopeRating: card.course.slopeRating,
        par: card.course.par,
        tee: card.course.tee || "Gelb",
        holeCount: card.holeCount,
        ...(card.course.holeData ? {holeData: card.course.holeData} : {}),
      };
      let courseId;
      if (courseIndex >= 0) {
        courseId = courses[courseIndex].id;
        courses[courseIndex] = {...courses[courseIndex], ...coursePatch};
      } else {
        courseId = db.nextCourseId;
        courses.push({...coursePatch, notes: "", nineHolePhcpFactor: 0.5, id: courseId});
        db.nextCourseId += 1;
      }
      db.courses = courses;

      const players = [...db.players];
      const profileName = String(db.profile.name || "").toLowerCase();
      const participants = card.players.map(entry=>{
        const isMe = Boolean(profileName) && entry.name.toLowerCase() === profileName;
        let player = players.find(p=>isMe ? p.isMe : (!p.isMe && p.name.toLowerCase() === entry.name.toLowerCase()));
        if (!player) {
          player = {id: db.nextPlayerId, name: entry.name, hcpIndex: entry.hcpIndex, isMe};
          players.push(player);
          db.nextPlayerId += 1;
        } else if (!isMe && player.hcpIndex !== entry.hcpIndex) {
          players[players.indexOf(player)] = {...player, hcpIndex: entry.hcpIndex};
        }
        return {
          playerId: String(player.id),
          name: entry.name,
          isMe,
          hcpIndex: entry.hcpIndex,
          courseHandicap: gameCourseHandicap(entry.hcpIndex, {...coursePatch, id: courseId}, card.holeCount),
        };
      });
      db.players = players;

      const holes = normalizeHoles(card.course.holeData, card.holeCount, card.course.par);
      const gameId = db.nextGameId;
      db.games = [...db.games, {
        id: gameId,
        createdAt: new Date().toISOString(),
        date: card.date,
        courseId,
        courseName: card.course.name,
        courseRating: card.course.courseRating,
        slopeRating: card.course.slopeRating,
        coursePar: card.course.par,
        holeCount: card.holeCount,
        holes,
        handicap: card.handicap,
        formats: card.formats,
        matchup: card.matchup.map(index=>participants[index]?.playerId).filter(Boolean),
        wolfChoices: Array.from({length: card.holeCount}, ()=>({partnerId:null, blind:false})),
        bbbAwards: Array.from({length: card.holeCount}, ()=>({bingo:null, bango:null, bongo:null})),
        nassauPresses: [],
        stake: card.stake,
        participants,
        scores: Array.from({length: card.holeCount}, ()=>({})),
        status: "running",
      }];
      db.nextGameId = gameId + 1;
      return db;
    });
    setView("games");
  };

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

  // Die Updater dürfen ihr Argument nicht verändern: React ruft sie im
  // Entwicklungsmodus (StrictMode) zweimal mit demselben Ausgangszustand auf.
  // Würde hier r.id gesetzt, liefe der zweite Durchlauf in den "bestehenden
  // Datensatz ändern"-Zweig und der neue Eintrag ginge verloren.
  const saveRound = r => {
    updateDB(db=>{
      const saved = r.id ? r : {...r, id:db.nextRoundId, createdAt:new Date().toISOString()};
      if (r.id) db.rounds=db.rounds.map(x=>x.id===r.id?saved:x);
      else { db.rounds=[...db.rounds,saved]; db.nextRoundId=db.nextRoundId+1; }
      if (saved.gameId) db.games=db.games.map(g=>g.id===saved.gameId?{...g,hcpRoundId:saved.id}:g);
      return db;
    });
    setForm(null);
  };
  const saveCourse = c => {
    updateDB(db=>{
      if (c.id) db.courses=db.courses.map(x=>x.id===c.id?c:x);
      else { db.courses=[...db.courses,{...c,id:db.nextCourseId}]; db.nextCourseId=db.nextCourseId+1; }
      return db;
    });
    setCourseForm(null);
  };
  const saveProfile = p => updateDB(db=>{ db.profile=p; return db; });
  const deleteRound = id => { updateDB(db=>{ db.rounds=db.rounds.filter(r=>r.id!==id); return db; }); setDeleteConfirm(null); };
  const clearSimulations = () => updateDB(db=>{ db.rounds=db.rounds.filter(r=>!r.simulated); return db; });

  // --- Games ---
  const addPlayer = player => {
    const id = db.nextPlayerId;
    updateDB(db=>{ db.players=[...db.players,{...player,id}]; db.nextPlayerId=id+1; return db; });
    return id;
  };
  const updatePlayer = (id, patch) => updateDB(db=>{
    db.players = db.players.map(player=>player.id === id ? {...player, ...patch} : player);
    return db;
  });

  /** Legt einen gescannten Platz an oder aktualisiert ihn und gibt seine ID zurueck. */
  const upsertCourse = card => {
    const existing = db.courses.find(c=>c.name.toLowerCase() === card.name.toLowerCase());
    const id = existing ? existing.id : db.nextCourseId;
    updateDB(db=>{
      const patch = {
        name: card.name,
        courseRating: card.courseRating,
        slopeRating: card.slopeRating,
        par: card.par,
        tee: card.tee || "Gelb",
        ...(card.holeCount ? {holeCount: card.holeCount} : {}),
        ...(card.holeData ? {holeData: card.holeData} : {}),
      };
      if (existing) db.courses = db.courses.map(c=>c.id === id ? {...c, ...patch} : c);
      else { db.courses = [...db.courses, {...patch, notes: "", nineHolePhcpFactor: 0.5, id}]; db.nextCourseId = id + 1; }
      return db;
    });
    return id;
  };

  const startGame = draft => {
    const id = db.nextGameId;
    updateDB(db=>{
      db.games=[...db.games,{
        ...draft,
        id,
        createdAt:new Date().toISOString(),
        scores:Array.from({length:draft.holeCount},()=>({})),
        status:"running",
      }];
      db.nextGameId=id+1;
      return db;
    });
    return id;
  };
  const updateGame = (gameId, fn) => updateDB(db=>{
    db.games=db.games.map(game=>game.id===gameId?fn({...game}):game);
    return db;
  });
  const setGameScore = (gameId, holeIndex, playerId, value) => updateGame(gameId, game=>{
    game.scores=game.scores.map((row,index)=>{
      if (index!==holeIndex) return row;
      const next={...row};
      if (Number.isFinite(value)) next[playerId]=value; else delete next[playerId];
      return next;
    });
    return game;
  });
  const setWolfChoice = (gameId, holeIndex, choice) => updateGame(gameId, game=>({
    ...game,
    wolfChoices: game.wolfChoices.map((entry, index)=>index===holeIndex ? {...entry, ...choice} : entry),
  }));
  const setBbbAward = (gameId, holeIndex, award, playerId) => updateGame(gameId, game=>({
    ...game,
    bbbAwards: game.bbbAwards.map((entry, index)=>index===holeIndex ? {...entry, [award]:playerId} : entry),
  }));
  const addNassauPress = (gameId, press) => updateGame(gameId, game=>(
    game.nassauPresses.some(entry=>entry.segment===press.segment && entry.from===press.from)
      ? game
      : {...game, nassauPresses:[...game.nassauPresses, press]}
  ));
  const finishGame = gameId => updateGame(gameId, game=>({...game, status:"finished", finishedAt:new Date().toISOString()}));
  const reopenGame = gameId => updateGame(gameId, game=>({...game, status:"running"}));
  const deleteGame = gameId => updateDB(db=>{ db.games=db.games.filter(game=>game.id!==gameId); return db; });
  // Die Verknüpfung entsteht erst beim tatsächlichen Speichern der Runde (siehe
  // saveRound) – bricht der Nutzer das Formular ab, bleibt das Spiel unverknüpft.
  const createHcpRoundFromGame = (gameId, prefill) => {
    setForm({...prefill, gameId});
    setView("rounds");
  };

  const sortedRounds = useMemo(()=>[...db.rounds].sort((a,b)=>b.date.localeCompare(a.date)),[db.rounds]);
  const hcpTimeline = useMemo(()=>buildHandicapTimeline(db.rounds, db.profile.startHcp ?? 54),[db.rounds, db.profile.startHcp]);
  const diffByRoundId = useMemo(()=>new Map(hcpTimeline.map(entry=>[entry.round.id, entry.diff])),[hcpTimeline]);
  const hcpRounds = useMemo(()=>sortedRounds.filter(isHcpEligible),[sortedRounds]);
  const recentTimeline = useMemo(()=>hcpTimeline.slice(-20),[hcpTimeline]);
  const recentDiffs = useMemo(()=>recentTimeline.map(entry=>entry.diff),[recentTimeline]);
  const estimatedHcp = useMemo(()=>hcpTimeline.length ? hcpTimeline[hcpTimeline.length-1].hcpAfter : null,[hcpTimeline]);

  // Als Simulation markierte Runden laufen im Dashboard mit. Daneben steht
  // immer der echte Index, damit klar bleibt, was Wunsch und was Wirklichkeit
  // ist – und ab welcher Runde die Charts gestrichelt weiterlaufen.
  const simulatedRoundIds = useMemo(()=>new Set(db.rounds.filter(r=>r.simulated).map(r=>r.id)),[db.rounds]);
  const realTimeline = useMemo(()=>simulatedRoundIds.size
    ? buildHandicapTimeline(db.rounds.filter(r=>!r.simulated), db.profile.startHcp ?? 54)
    : hcpTimeline,[simulatedRoundIds, db.rounds, db.profile.startHcp, hcpTimeline]);
  const realHcp = useMemo(()=>realTimeline.length ? realTimeline[realTimeline.length-1].hcpAfter : null,[realTimeline]);
  const projectedStartIndex = useMemo(()=>{
    if (!simulatedRoundIds.size) return null;
    const index = hcpTimeline.findIndex(entry=>simulatedRoundIds.has(entry.round.id));
    return index<0 ? null : index;
  },[hcpTimeline, simulatedRoundIds]);
  const nextSimulationDate = useMemo(()=>getNextDate(getLatestRoundDate(db.rounds)),[db.rounds]);

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
  const realDisplayHcp = realHcp??db.profile.startHcp??54;
  // Number(): ein importiertes Profil kann den Start-HCP als String mitbringen.
  const realHcpLabel = Number(realDisplayHcp).toFixed(1);

  // Der Profilinhaber ist in Games ein Spieler wie jeder andere – nur dass sein
  // Handicap-Index aus dem Tracker kommt statt von Hand gepflegt zu werden.
  // Dort zaehlt der echte Index: an einem Flight-Spiel haengt eine Abrechnung,
  // die keine Simulation mitrechnen darf.
  useEffect(()=>{
    if (!db.profile.name) return;
    const me = db.players.find(p=>p.isMe);
    if (me && me.name===db.profile.name && me.hcpIndex===round1(realDisplayHcp)) return;
    updateDB(db=>{
      const players=[...db.players];
      const index=players.findIndex(p=>p.isMe);
      if (index>=0) players[index]={...players[index], name:db.profile.name, hcpIndex:round1(realDisplayHcp)};
      else { players.push({id:db.nextPlayerId, name:db.profile.name, hcpIndex:round1(realDisplayHcp), isMe:true}); db.nextPlayerId+=1; }
      db.players=players;
      return db;
    });
  },[db.profile.name, db.players, realDisplayHcp]);

  const newRound = () => setForm({ date:new Date().toISOString().slice(0,10), mode:"Stableford", format:"Einzel", holes:18, submitted:false, markerSigned:false, nineHoleAllowed:false, simulated:false, playingHcp:displayHcp });

  const cardPrompt = pendingCard && (
    <Modal title={pendingCard.kind==="player" ? "Mitspieler übernehmen?" : pendingCard.kind==="game" ? "Spiel mitspielen?" : "Platz übernehmen?"} onClose={dismissCard}>
      <div style={{fontSize:15,fontWeight:600,marginBottom:6}}>{describeShareCard(pendingCard)}</div>
      <p style={{fontSize:14,lineHeight:1.6,color:"var(--color-text-secondary)",marginTop:0}}>
        {pendingCard.kind==="player"
          ? "Der Spieler steht dir danach in den Games zur Auswahl. Ein vorhandener Eintrag mit demselben Namen wird aktualisiert."
          : pendingCard.kind==="game"
          ? "Das Spiel wird auf diesem Gerät mit denselben Spielern, Formaten und Einsätzen angelegt. Platz und Mitspieler kommen mit, du schreibst deine eigenen Scores mit – am Ende vergleicht ihr die Abrechnungen."
          : "Der Platz landet in deiner Platzliste. Ein vorhandener Platz mit demselben Namen und Abschlag wird aktualisiert."}
      </p>
      <div style={{display:"flex",gap:8,marginTop:16,flexWrap:"wrap"}}>
        <button onClick={()=>acceptCard(pendingCard)} style={{padding:"9px 18px",borderRadius:"var(--border-radius-md)",background:COLORS.hcp,color:"#fff",border:"none",cursor:"pointer",fontWeight:600,fontSize:14,fontFamily:"var(--font-sans)"}}>{pendingCard.kind==="game" ? "Mitspielen" : "Übernehmen"}</button>
        <button onClick={dismissCard} style={{padding:"9px 18px",borderRadius:"var(--border-radius-md)",background:"transparent",border:`0.5px solid ${COLORS.border}`,cursor:"pointer",color:"var(--color-text-primary)",fontSize:14,fontFamily:"var(--font-sans)"}}>Verwerfen</button>
      </div>
    </Modal>
  );

  // Impressum und Datenschutz muessen auch ohne Profil erreichbar sein, also vor der Landing Page.
  if (!db.profile.name) {
    if (isLegalView(view)) {
      return <LegalStandalonePage page={view} onOpenLegal={setView} onBack={()=>setView("dashboard")}/>;
    }
    return <>
      <LandingPage profile={db.profile} onSave={saveProfile} onOpenLegal={setView}/>
      {cardPrompt}
    </>;
  }

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
        simulated={simulatedRoundIds.size>0}
      />
      <div style={{flex:1,minWidth:0,display:"flex",flexDirection:"column"}}>
        {!isDesktop && <MobileTopBar title={activeNavItem?.label ?? LEGAL_VIEW_LABELS[view] ?? "Dashboard"} displayHcp={displayHcp} simulated={simulatedRoundIds.size>0} onOpenNav={()=>setNavOpen(true)} maxWidth={contentMaxWidth}/>}
        <div style={{maxWidth:contentMaxWidth,margin:"0 auto",padding:contentShellPadding,fontFamily:"var(--font-sans)",color:"var(--color-text-primary)",boxSizing:"border-box",width:"100%"}}>
          <div style={{...cardStyle,display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:18,gap:16,flexWrap:"wrap",padding:isDesktop?"22px 24px":"18px 20px",background:"linear-gradient(140deg, rgba(20,46,37,0.96) 0%, rgba(18,57,44,0.94) 45%, rgba(29,158,117,0.76) 100%)",color:"#fff",position:"relative",overflow:"hidden"}}>
            <div style={{position:"absolute",inset:0,background:"radial-gradient(circle at top right, rgba(255,255,255,0.16), transparent 28%), linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)",backgroundSize:"auto, 24px 24px",opacity:0.4,pointerEvents:"none"}}/>
            {/* Bildmarke mittig in der Karte. Die Texte darüber sind positioniert
                (position:relative) und werden deshalb über dem Wolf gezeichnet. */}
            <div aria-hidden="true" style={{position:"absolute",inset:0,display:"grid",placeItems:"center",pointerEvents:"none",opacity:0.34,filter:"drop-shadow(0 10px 22px rgba(4,20,14,0.4))"}}>
              <WolfFlagMark size={isDesktop?168:128}/>
            </div>
            <div style={{position:"relative"}}>
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
                  <span style={{fontSize:11,color:"rgba(255,255,255,0.68)"}}>{estimatedHcp?(simulatedRoundIds.size?"HCP Index im Szenario":"Aktueller HCP Index"):"Start-HCP"}</span>
                  <span style={{width:18,height:18,borderRadius:"50%",border:"1px solid rgba(255,255,255,0.22)",background:"rgba(255,255,255,0.08)",color:"#fff",fontSize:11,fontWeight:700,display:"inline-flex",alignItems:"center",justifyContent:"center"}}>?</span>
                </div>
                <div style={{fontSize:44,fontWeight:700,color:"#fff",lineHeight:1}}>{displayHcp}</div>
                <div style={{fontSize:11,color:"rgba(255,255,255,0.68)",marginTop:6}}>{estimatedHcp?`aus ${Math.min(hcpRounds.length,20)} HCP-wirks. Runden`:"noch keine gewerteten Runden"}</div>
                {simulatedRoundIds.size>0 && (
                  <div style={{marginTop:8,display:"inline-flex",alignItems:"center",gap:6,padding:"4px 10px",borderRadius:999,background:"rgba(197,107,26,0.32)",border:"1px solid rgba(255,208,158,0.45)",fontSize:11,color:"#ffe7cf"}}>
                    <span style={{width:7,height:7,borderRadius:"50%",background:"#F5AC63",flexShrink:0}}/>
                    {simulatedRoundIds.size===1 ? "1 Simulationsrunde" : `${simulatedRoundIds.size} Simulationsrunden`} · echt: {realHcpLabel}
                  </div>
                )}
              </HcpTooltip>
            </div>
          </div>

          {view==="dashboard" && <Dashboard
            rounds={sortedRounds}
            hcpRounds={hcpRounds}
            recentDiffs={recentDiffs}
            estimatedHcp={estimatedHcp}
            onNew={()=>{newRound();setView("rounds");}}
            hcpTimeline={hcpTimeline}
            diffByRoundId={diffByRoundId}
            projectedStartIndex={projectedStartIndex}
            simulatedRoundIds={simulatedRoundIds}
            actionArea={simulatedRoundIds.size>0 ? (
              <div style={{...subtleCardStyle,padding:"14px 16px",marginBottom:24,border:"1px solid rgba(197,107,26,0.26)",background:"linear-gradient(180deg, #fff9f2 0%, #fff1df 100%)",display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12,flexWrap:"wrap"}}>
                <div>
                  <div style={{fontSize:12,fontWeight:700,letterSpacing:"0.08em",textTransform:"uppercase",color:"#9a5314",marginBottom:6}}>Was wäre wenn</div>
                  <div style={{fontSize:13,color:"#6f5841",lineHeight:1.6,maxWidth:520}}>
                    Dashboard, Charts und Wertungsfenster laufen mit {simulatedRoundIds.size===1 ? "einer Simulationsrunde" : `${simulatedRoundIds.size} Simulationsrunden`} weiter (orange markiert und gestrichelt). Dein echter Index liegt bei {realHcpLabel}.
                  </div>
                </div>
                <button onClick={clearSimulations} style={{padding:"8px 14px",borderRadius:"var(--border-radius-md)",background:"transparent",border:"1px solid rgba(197,107,26,0.32)",color:"#9a5314",cursor:"pointer",fontSize:13,fontWeight:600,flexShrink:0}}>Simulationen verwerfen</button>
              </div>
            ) : null}
            variant="focus"
          />}
          {view==="games" && <GamesView
            games={[...db.games].sort((a,b)=>String(b.date).localeCompare(String(a.date)) || b.id-a.id)}
            courses={db.courses}
            players={db.players}
            profile={db.profile}
            displayHcp={realDisplayHcp}
            onStartGame={startGame}
            onAddPlayer={addPlayer}
            onUpdatePlayer={updatePlayer}
            onUpsertCourse={upsertCourse}
            onScore={setGameScore}
            onWolfChoice={setWolfChoice}
            onBbbAward={setBbbAward}
            onNassauPress={addNassauPress}
            onFinishGame={finishGame}
            onReopenGame={reopenGame}
            onDeleteGame={deleteGame}
            onCreateHcpRound={createHcpRoundFromGame}
          />}
          {view==="rounds" && <RoundList rounds={sortedRounds} courses={db.courses} onNew={newRound} onEdit={r=>setForm({...r})} onDelete={id=>setDeleteConfirm(id)} countingIds={countingIds} diffByRoundId={diffByRoundId}/>}
          {view==="courses" && <CourseList courses={db.courses} onNew={()=>setCourseForm({name:"",courseRating:"",slopeRating:"",par:36,tee:"Gelb",notes:"",nineHolePhcpFactor:0.5})} onEdit={c=>setCourseForm({...c})}/>}
          {view==="profile" && <>
            <ProfileForm profile={db.profile} onSave={saveProfile}/>
            <div style={{...cardStyle,padding:"20px 24px",marginTop:14}}>
              <div style={{fontSize:12,fontWeight:700,letterSpacing:"0.12em",textTransform:"uppercase",color:"#1D9E75",marginBottom:8}}>Deine Spielerkarte</div>
              <ShareCardPanel
                card={{kind:"player", name: db.profile.name, hcpIndex: round1(displayHcp)}}
                hint="Zeig den Code deinen Mitspielern: Wer ihn mit der Kamera seines Telefons scannt, bekommt deinen Namen und deinen aktuellen HCP-Index in sein Spiel – ohne Abtippen. Der Code enthält nur diese beiden Angaben und läuft nicht über einen Server."
              />
            </div>
          </>}
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
          {view==="info" && <HcpInfo onOpenLegal={selectView}/>}
          {isLegalView(view) && <LegalPage page={view} onOpenLegal={selectView} onBack={()=>selectView("dashboard")} backLabel="Zum Dashboard"/>}

          {cardPrompt}
          <UpdateAppPrompt/>
          <InstallAppPrompt/>

          {form && <Modal title={form.id?(form.simulated?"Simulation bearbeiten":"Runde bearbeiten"):"Neue Runde"} onClose={()=>setForm(null)}><RoundForm initial={form} courses={db.courses} currentHcp={displayHcp} recentDiffs={recentDiffs} nextSimulationDate={nextSimulationDate} onSave={saveRound} onCancel={()=>setForm(null)}/></Modal>}
          {courseForm && <Modal title={courseForm.id?"Platz bearbeiten":"Neuer Platz"} onClose={()=>setCourseForm(null)}><CourseForm initial={courseForm} rounds={db.rounds} startHcp={db.profile.startHcp ?? 54} onSave={saveCourse} onCancel={()=>setCourseForm(null)}/></Modal>}
          {deleteConfirm && <Modal title="Runde löschen?" onClose={()=>setDeleteConfirm(null)}>
            <p style={{color:COLORS.textSec,fontSize:14}}>Diese Runde wird unwiderruflich gelöscht.</p>
            <div style={{display:"flex",gap:8,marginTop:16}}>
              <button onClick={()=>deleteRound(deleteConfirm)} style={{padding:"8px 16px",borderRadius:"var(--border-radius-md)",background:"#E24B4A",color:"#fff",border:"none",cursor:"pointer",fontWeight:500}}>Löschen</button>
              <button onClick={()=>setDeleteConfirm(null)} style={{padding:"8px 16px",borderRadius:"var(--border-radius-md)",background:"transparent",border:`0.5px solid ${COLORS.border}`,cursor:"pointer",color:"var(--color-text-primary)"}}>Abbrechen</button>
            </div>
          </Modal>}

          <AppFooter onOpenLegal={selectView}/>
        </div>
      </div>
    </div>
  );
}
