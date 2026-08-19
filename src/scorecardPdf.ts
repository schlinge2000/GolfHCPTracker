/**
 * Liest eine Online-Scorekarte aus dem Textlayer eines PDFs.
 *
 * Diese Karten tragen genau die Angaben, die der golf.de-Import nicht liefert:
 * Par und Stroke Index je Loch. Dazu kommen Platzname, Abschlag, Course Rating
 * und Slope – alles, was ein Platz in der App braucht.
 *
 * Zwei Kartenarten sind erprobt, und sie sind unterschiedlich gebaut:
 *
 *   PC CADDIE      "Loch Par Index Score B N"        -> Par vor Stroke Index
 *   scorecard4you  "Loch Herren Damen Hcp. Par Earn" -> Stroke Index vor Par,
 *                  davor zwei Spalten mit Laengen, Rating als eigene Zeilen
 *                  ("CR 73,4 75,6" / "Slope 132 131"), alles zweimal
 *                  nebeneinander gedruckt.
 *
 * Deshalb wird nicht auf eine feste Spaltenfolge geraten: die Kopfzeile der
 * Tabelle sagt, in welcher Spalte Par und Stroke Index stehen. Fehlt sie, gilt
 * die PC-CADDIE-Folge.
 *
 * Die Funktion arbeitet auf fertigen Zeilen und ist deshalb ohne PDF-Werkzeug
 * testbar. Das Zusammensetzen der Zeilen aus den Textelementen (nach Y-Position
 * gruppiert, nach X sortiert) passiert im Aufrufer.
 */

export type ScorecardHole = { nr: number; par: number; si: number };

/** Eine Abschlag-Spalte der Karte. Karten mit Herren/Damen bringen zwei mit. */
export type ScorecardTee = {
  name: string | null;
  courseRating: number | null;
  slopeRating: number | null;
};

/** Codes statt Saetze: die Anzeige uebersetzt sie. */
export type ScorecardWarning =
  | "holes-incomplete"
  | "si-not-unique"
  | "par-mismatch"
  | "rating-missing";

export type ParsedScorecard = {
  courseName: string | null;
  /** Der erste Abschlag der Karte – bei Herren/Damen-Karten also Herren. */
  tee: string | null;
  courseRating: number | null;
  slopeRating: number | null;
  /** Alle Abschlag-Spalten, damit die Anzeige die Wahl lassen kann. */
  tees: ScorecardTee[];
  holeCount: number;
  /** Summe der Loch-Pars; null, wenn keine Loecher gefunden wurden. */
  par: number | null;
  /** Im PDF ausgewiesene Gesamtsumme (Zeile "1-18"), zum Abgleich. */
  statedPar: number | null;
  holes: ScorecardHole[];
  warnings: ScorecardWarning[];
};

const COURSE_ROW = /^(.+?)\s+(9|18)\s+Loch\b/i;
/** Abschlag mit Rating in einer Zeile, z.B. "gelb (71.7/130)". */
const TEE_ROW = /^([A-Za-zÄÖÜäöüß\- ]{2,20}?)\s*\(\s*(\d{2,3}[.,]\d)\s*\/\s*(\d{2,3})\s*\)/;
/** Summenzeile "1-9" oder "1-18"; dahinter steht die Zeile wie eine Lochzeile. */
const TOTAL_ROW = /^1\s*-\s*(9|18)\b(.*)$/;
/** Ein Club-Name als letzter Ausweg, wenn keine "… 18 Loch"-Zeile da ist. */
const CLUB_ROW = /(?:^|[\s:(])((?:Golf|GC |G\.C\.)[A-Za-zÄÖÜäöüß0-9.&'\- ]*)/i;

const HOLE_LABELS = ["loch", "hole"];
const PAR_LABELS = ["par"];
const SI_LABELS = ["index", "hcp", "si", "vorgabe", "stroke"];

function toNumber(value: string): number {
  return parseFloat(value.replace(",", "."));
}

function words(line: string): string[] {
  return line.split(" ").filter(Boolean);
}

/** Spaltenbeschriftung ohne Satzzeichen: "Hcp." und "Par:" sollen treffen. */
function labelOf(token: string): string {
  return token.replace(/[.:,;]+$/, "").toLowerCase();
}

function isCount(token: string): boolean {
  return /^\d{1,4}$/.test(token);
}

/**
 * Karten fuer zwei Spieler werden zweimal nebeneinander gedruckt – jede Zeile
 * steht dann doppelt in sich. Ist die zweite Haelfte Wort fuer Wort die erste,
 * bleibt nur eine uebrig; sonst bleibt die Zeile, wie sie ist.
 */
function unmirror(line: string): string {
  const parts = words(line);
  if (parts.length < 2 || parts.length % 2 !== 0) return line;
  const half = parts.length / 2;
  for (let i = 0; i < half; i += 1) {
    if (parts[i] !== parts[i + half]) return line;
  }
  return parts.slice(0, half).join(" ");
}

/** Abstand von der Lochnummer zu Par und Stroke Index, plus die Spalten davor. */
type ScorecardLayout = { par: number; si: number; teeNames: string[] };

const PC_CADDIE_LAYOUT: ScorecardLayout = { par: 1, si: 2, teeNames: [] };

function readLayout(lines: string[]): ScorecardLayout {
  for (const line of lines) {
    const parts = words(line);
    const holeAt = parts.findIndex(part => HOLE_LABELS.includes(labelOf(part)));
    if (holeAt < 0) continue;
    const parAt = parts.findIndex((part, i) => i > holeAt && PAR_LABELS.includes(labelOf(part)));
    const siAt = parts.findIndex((part, i) => i > holeAt && SI_LABELS.includes(labelOf(part)));
    if (parAt < 0 || siAt < 0) continue;
    // Zwischen Loch und der ersten Wertungsspalte stehen die Laengen – ihre
    // Beschriftung ("Herren", "Damen") ist der Name des Abschlags.
    const teeNames = parts
      .slice(holeAt + 1, Math.min(parAt, siAt))
      .filter(part => /[A-Za-zÄÖÜäöüß]/.test(part));
    return { par: parAt - holeAt, si: siAt - holeAt, teeNames };
  }
  return PC_CADDIE_LAYOUT;
}

function readHole(line: string, layout: ScorecardLayout): ScorecardHole | null {
  const parts = words(line);
  const last = Math.max(layout.par, layout.si);
  if (parts.length <= last) return null;
  // Alles bis zur letzten gebrauchten Spalte muss eine Zahl sein: so fallen
  // Summenzeilen ("OUT 37 - -") und die leeren Score-Spalten heraus.
  for (let i = 0; i <= last; i += 1) {
    if (!isCount(parts[i])) return null;
  }
  const nr = parseInt(parts[0], 10);
  const par = parseInt(parts[layout.par], 10);
  const si = parseInt(parts[layout.si], 10);
  if (nr < 1 || nr > 18) return null;
  if (par < 3 || par > 6) return null;
  if (si < 1 || si > 18) return null;
  return { nr, par, si };
}

/** Zahlen einer Zeile hinter ihrer Beschriftung, z.B. "CR 73,4 75,6". */
function valuesAfterLabel(line: string, pattern: RegExp): number[] {
  return words(line)
    .slice(1)
    .filter(part => pattern.test(part))
    .map(toNumber);
}

export function parseScorecardPdfLines(rawLines: string[]): ParsedScorecard {
  const lines = rawLines
    .map(line => unmirror(line.replace(/\s+/g, " ").trim()))
    .filter(Boolean);
  const layout = readLayout(lines);

  const byNumber = new Map<number, ScorecardHole>();
  const statedByHoles = new Map<number, number>();
  const labelledTees: ScorecardTee[] = [];
  let courseRatings: number[] = [];
  let slopeRatings: number[] = [];
  let courseName: string | null = null;

  lines.forEach((line, index) => {
    const hole = readHole(line, layout);
    if (hole) {
      // Die erste Nennung gewinnt: die Karte wiederholt Zeilen fuer die
      // Score-Spalten.
      if (!byNumber.has(hole.nr)) byNumber.set(hole.nr, hole);
      return;
    }

    const course = COURSE_ROW.exec(line);
    if (course && !courseName) {
      courseName = course[1].trim();
      return;
    }

    const teeRow = TEE_ROW.exec(line);
    if (teeRow) {
      labelledTees.push({
        name: teeRow[1].trim(),
        courseRating: toNumber(teeRow[2]),
        slopeRating: parseInt(teeRow[3], 10),
      });
      return;
    }

    const total = TOTAL_ROW.exec(line);
    if (total) {
      // Die Summenzeile ist wie eine Lochzeile gebaut, nur ohne Lochnummer.
      const value = words(total[2])[layout.par - 1];
      const holes = parseInt(total[1], 10);
      if (value && isCount(value) && !statedByHoles.has(holes)) {
        statedByHoles.set(holes, parseInt(value, 10));
      }
      return;
    }

    const head = labelOf(words(line)[0] ?? "");
    if (head === "cr" || head === "course-rating" || head === "courserating") {
      const found = valuesAfterLabel(line, /^\d{2,3}[.,]\d$/);
      if (found.length && !courseRatings.length) courseRatings = found;
      return;
    }
    if (head === "slope") {
      const found = valuesAfterLabel(line, /^\d{2,3}$/).filter(value => value >= 55 && value <= 155);
      if (found.length && !slopeRatings.length) slopeRatings = found;
      return;
    }

    // "Platz" steht als Beschriftung ueber dem Wert; falls die Zeile mit der
    // Lochzahl fehlt, nehmen wir den Nachbarn darunter.
    if (!courseName && /^platz$/i.test(line) && lines[index + 1]) {
      courseName = lines[index + 1].replace(COURSE_ROW, "$1").trim() || null;
    }
  });

  // Karten ohne Abschlagsfarbe nennen die Rating-Zeilen spaltenweise: die
  // Reihenfolge ist die der Laengen-Spalten aus der Kopfzeile.
  const columnCount = layout.teeNames.length || Math.max(courseRatings.length, slopeRatings.length);
  const columnTees: ScorecardTee[] = Array.from({ length: columnCount }, (_, i) => ({
    name: layout.teeNames[i] ?? null,
    courseRating: courseRatings[i] ?? null,
    slopeRating: slopeRatings[i] ?? null,
  })).filter(entry => entry.courseRating !== null || entry.slopeRating !== null);
  const tees = labelledTees.length ? labelledTees : columnTees;

  if (!courseName) {
    for (const line of lines) {
      if (/www\.|https?:|@/i.test(line)) continue;
      const club = CLUB_ROW.exec(line);
      const name = club?.[1].trim();
      if (name && name.length >= 4) {
        courseName = name;
        break;
      }
    }
  }

  const holes = [...byNumber.values()].sort((a, b) => a.nr - b.nr);
  const holeCount = holes.length > 9 ? 18 : 9;
  const par = holes.length ? holes.reduce((sum, hole) => sum + hole.par, 0) : null;
  const statedPar = statedByHoles.get(holeCount) ?? null;

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
  const primary = tees[0] ?? null;
  if (primary?.courseRating == null || primary?.slopeRating == null) {
    warnings.push("rating-missing");
  }

  return {
    courseName,
    tee: primary?.name ?? null,
    courseRating: primary?.courseRating ?? null,
    slopeRating: primary?.slopeRating ?? null,
    tees,
    holeCount,
    par,
    statedPar,
    holes,
    warnings,
  };
}

/** Nur brauchbar, wenn wenigstens die Loecher vollstaendig sind. */
export function isUsableScorecard(parsed: ParsedScorecard): boolean {
  return parsed.holes.length > 0 && !parsed.warnings.includes("holes-incomplete");
}
