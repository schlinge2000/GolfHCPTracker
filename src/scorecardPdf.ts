/**
 * Liest eine Online-Scorekarte (PC CADDIE) aus dem Textlayer eines PDFs.
 *
 * Diese Karten tragen genau die Angaben, die der golf.de-Import nicht liefert:
 * Par und Stroke Index je Loch. Dazu kommen Platzname, Abschlag, Course Rating
 * und Slope – alles, was ein Platz in der App braucht.
 *
 * Die Funktion arbeitet auf fertigen Zeilen und ist deshalb ohne PDF-Werkzeug
 * testbar. Das Zusammensetzen der Zeilen aus den Textelementen (nach Y-Position
 * gruppiert, nach X sortiert) passiert im Aufrufer.
 */

export type ScorecardHole = { nr: number; par: number; si: number };

/** Codes statt Saetze: die Anzeige uebersetzt sie. */
export type ScorecardWarning =
  | "holes-incomplete"
  | "si-not-unique"
  | "par-mismatch"
  | "rating-missing";

export type ParsedScorecard = {
  courseName: string | null;
  tee: string | null;
  courseRating: number | null;
  slopeRating: number | null;
  holeCount: number;
  /** Summe der Loch-Pars; null, wenn keine Loecher gefunden wurden. */
  par: number | null;
  /** Im PDF ausgewiesene Gesamtsumme (Zeile "1-18"), zum Abgleich. */
  statedPar: number | null;
  holes: ScorecardHole[];
  warnings: ScorecardWarning[];
};

const HOLE_ROW = /^(\d{1,2})\s+([3-6])\s+(\d{1,2})(?:\s|$)/;
const COURSE_ROW = /^(.+?)\s+(9|18)\s+Loch\b/i;
const TEE_ROW = /^([A-Za-zÄÖÜäöüß\- ]{2,20}?)\s*\(\s*(\d{2,3}[.,]\d)\s*\/\s*(\d{2,3})\s*\)/;
const TOTAL_ROW = /^1\s*-\s*(?:18|9)\s+(\d{2,3})\b/;

function toNumber(value: string): number {
  return parseFloat(value.replace(",", "."));
}

export function parseScorecardPdfLines(rawLines: string[]): ParsedScorecard {
  const lines = rawLines.map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean);

  const byNumber = new Map<number, ScorecardHole>();
  let courseName: string | null = null;
  let tee: string | null = null;
  let courseRating: number | null = null;
  let slopeRating: number | null = null;
  let statedPar: number | null = null;

  lines.forEach((line, index) => {
    const hole = HOLE_ROW.exec(line);
    if (hole) {
      const nr = parseInt(hole[1], 10);
      // Nur echte Lochnummern, und die erste Nennung gewinnt: die Karte
      // wiederholt Zeilen fuer die Score-Spalten.
      if (nr >= 1 && nr <= 18 && !byNumber.has(nr)) {
        byNumber.set(nr, { nr, par: parseInt(hole[2], 10), si: parseInt(hole[3], 10) });
      }
      return;
    }

    const course = COURSE_ROW.exec(line);
    if (course && !courseName) {
      courseName = course[1].trim();
      return;
    }

    const teeRow = TEE_ROW.exec(line);
    if (teeRow && courseRating === null) {
      tee = teeRow[1].trim();
      courseRating = toNumber(teeRow[2]);
      slopeRating = parseInt(teeRow[3], 10);
      return;
    }

    const total = TOTAL_ROW.exec(line);
    if (total && statedPar === null) {
      statedPar = parseInt(total[1], 10);
      return;
    }

    // "Platz" steht als Beschriftung ueber dem Wert; falls die Zeile mit der
    // Lochzahl fehlt, nehmen wir den Nachbarn darunter.
    if (!courseName && /^platz$/i.test(line) && lines[index + 1]) {
      courseName = lines[index + 1].replace(COURSE_ROW, "$1").trim() || null;
    }
  });

  const holes = [...byNumber.values()].sort((a, b) => a.nr - b.nr);
  const holeCount = holes.length > 9 ? 18 : 9;
  const par = holes.length ? holes.reduce((sum, hole) => sum + hole.par, 0) : null;

  const warnings: ScorecardWarning[] = [];
  const expected = holes.length ? holeCount : 0;
  if (!holes.length || holes.length !== expected || holes.some((hole, i) => hole.nr !== i + 1)) {
    warnings.push("holes-incomplete");
  }
  const indexes = new Set(holes.map(hole => hole.si));
  if (holes.length && (indexes.size !== holes.length || holes.some(hole => hole.si < 1 || hole.si > holeCount))) {
    warnings.push("si-not-unique");
  }
  if (par !== null && statedPar !== null && par !== statedPar) {
    warnings.push("par-mismatch");
  }
  if (courseRating === null || slopeRating === null) {
    warnings.push("rating-missing");
  }

  return { courseName, tee, courseRating, slopeRating, holeCount, par, statedPar, holes, warnings };
}

/** Nur brauchbar, wenn wenigstens die Loecher vollstaendig sind. */
export function isUsableScorecard(parsed: ParsedScorecard): boolean {
  return parsed.holes.length > 0 && !parsed.warnings.includes("holes-incomplete");
}
