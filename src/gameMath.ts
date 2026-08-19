// Rechenkern für die Rubrik "Games" (Spiele gegeneinander).
//
// Bewusst frei von React und localStorage: alles hier ist eine reine Funktion
// über Loch-Daten, Vorgaben und Bruttoschlägen, damit die Spielformate ohne UI
// getestet werden können (siehe gameMath.test.ts).

/** Beschriftung in beiden Sprachen; die Anzeige waehlt eine aus. */
export type LangText = { de: string; en: string };

export type HoleInfo = {
  nr: number; // Lochnummer, 1-basiert
  par: number;
  si: number; // Stroke Index / Vorgabenverteilung, 1 = schwerstes Loch
};

/** Vorgabenmodus für ein Spiel. */
export type HandicapMode =
  | "difference" // bester Spieler spielt Scratch, alle anderen die Differenz (Lochspiel-Standard)
  | "full" // jeder bekommt sein volles Course Handicap
  | "gross"; // Brutto, niemand bekommt Vorgabenschläge

export type HandicapConfig = {
  mode: HandicapMode;
  percent: number; // Vorgabenanteil in Prozent, z.B. 100 (Einzel) oder 90 (Vierball)
};

export const DEFAULT_HANDICAP_CONFIG: HandicapConfig = { mode: "difference", percent: 100 };

// Vorschlagsverteilung für den Stroke Index. Front nine bekommt die ungeraden,
// back nine die geraden Indizes – so wie es auf den meisten Scorekarten steht.
// Das ist nur ein Startwert; die echte Verteilung kommt von der Scorekarte.
const SI_SUGGESTION_18 = [7, 11, 15, 1, 13, 5, 17, 3, 9, 8, 12, 16, 2, 14, 6, 18, 4, 10];
const SI_SUGGESTION_9 = [4, 8, 2, 6, 1, 9, 3, 7, 5];

// Typische Positionen für Par-3- und Par-5-Löcher (0-basiert, überschneidungsfrei).
const PAR3_SLOTS_18 = [2, 7, 11, 16, 5, 14];
const PAR5_SLOTS_18 = [4, 8, 12, 17, 1, 10];
const PAR3_SLOTS_9 = [2, 7, 4];
const PAR5_SLOTS_9 = [3, 8, 0];

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

/** Sinnvolle Par-Verteilung für `holeCount` Löcher mit `totalPar` Gesamt-Par. */
export function suggestPars(holeCount: number, totalPar?: number | string): number[] {
  const count = holeCount === 9 ? 9 : 18;
  const target = clampInt(totalPar, count * 3, count * 5, count * 4);
  const pars = new Array(count).fill(4);
  const par3Slots = count === 9 ? PAR3_SLOTS_9 : PAR3_SLOTS_18;
  const par5Slots = count === 9 ? PAR5_SLOTS_9 : PAR5_SLOTS_18;

  let total = 4 * count;
  for (const slot of par3Slots) {
    if (total <= target) break;
    if (pars[slot] !== 4) continue;
    pars[slot] = 3;
    total -= 1;
  }
  for (const slot of par5Slots) {
    if (total >= target) break;
    if (pars[slot] !== 4) continue;
    pars[slot] = 5;
    total += 1;
  }
  // Restabweichung (ungewöhnliches Gesamt-Par) gleichmäßig auf die übrigen Löcher verteilen.
  for (let i = 0; total > target && i < count; i += 1) {
    if (pars[i] > 3) { pars[i] -= 1; total -= 1; }
  }
  for (let i = 0; total < target && i < count; i += 1) {
    if (pars[i] < 5) { pars[i] += 1; total += 1; }
  }
  return pars;
}

/** Vollständiger Vorschlag für die Loch-Daten eines Platzes. */
export function suggestHoles(holeCount: number, totalPar?: number | string): HoleInfo[] {
  const count = holeCount === 9 ? 9 : 18;
  const pars = suggestPars(count, totalPar);
  const sis = count === 9 ? SI_SUGGESTION_9 : SI_SUGGESTION_18;
  return pars.map((par, index) => ({ nr: index + 1, par, si: sis[index] }));
}

/**
 * Bringt beliebige (auch importierte oder unvollständige) Loch-Daten in eine
 * verwendbare Form: richtige Länge, Par in [3,6], und ein Stroke Index, der
 * garantiert eine Permutation von 1..n ist. Lücken werden aus dem Vorschlag
 * aufgefüllt, damit die Netto-Rechnung nie auf doppelten Indizes läuft.
 */
export function normalizeHoles(raw: unknown, holeCount: number, totalPar?: number | string): HoleInfo[] {
  const count = holeCount === 9 ? 9 : 18;
  const fallback = suggestHoles(count, totalPar);
  const source = Array.isArray(raw) ? raw : [];

  const pars = fallback.map((hole, index) => {
    const entry = source[index] as { par?: unknown } | undefined;
    const par = entry ? clampInt(entry.par, 3, 6, hole.par) : hole.par;
    return par;
  });

  // Stroke Index: gültige, noch nicht vergebene Werte übernehmen, Rest auffüllen.
  const taken = new Set<number>();
  const sis: (number | null)[] = fallback.map((_, index) => {
    const entry = source[index] as { si?: unknown } | undefined;
    if (!entry) return null;
    const si = typeof entry.si === "number" ? entry.si : parseInt(String(entry.si ?? ""), 10);
    if (!Number.isFinite(si) || si < 1 || si > count || taken.has(si)) return null;
    taken.add(si);
    return si;
  });
  const free: number[] = [];
  for (let si = 1; si <= count; si += 1) if (!taken.has(si)) free.push(si);
  for (let index = 0; index < count; index += 1) {
    if (sis[index] === null) sis[index] = free.shift() ?? index + 1;
  }

  return fallback.map((hole, index) => ({ nr: index + 1, par: pars[index], si: sis[index] as number }));
}

export function totalPar(holes: HoleInfo[]): number {
  return holes.reduce((sum, hole) => sum + hole.par, 0);
}

/**
 * Vorgabenschläge auf einem einzelnen Loch.
 * Bei Handicaps über der Lochzahl gibt es zwei (oder mehr) Schläge auf den
 * schwersten Löchern. Bei Plusvorgaben (negatives Handicap) werden Schläge an
 * den LEICHTESTEN Löchern abgezogen – deshalb die umgekehrte Rangfolge.
 */
export function strokesForHole(gameHandicap: number, si: number, holeCount: number): number {
  const handicap = Math.round(gameHandicap);
  if (!Number.isFinite(handicap) || handicap === 0) return 0;
  const sign = handicap > 0 ? 1 : -1;
  const abs = Math.abs(handicap);
  const full = Math.floor(abs / holeCount);
  const remainder = abs - full * holeCount;
  const rank = sign > 0 ? si : holeCount - si + 1;
  const strokes = full + (rank <= remainder ? 1 : 0);
  return strokes === 0 ? 0 : sign * strokes; // nicht sign*0, das ergäbe -0

}

/** Vorgabenschläge über alle Löcher. */
export function strokeAllocation(gameHandicap: number, holes: HoleInfo[]): number[] {
  return holes.map(hole => strokesForHole(gameHandicap, hole.si, holes.length));
}

/**
 * Rechnet Course Handicaps in die Spielvorgaben dieses Spiels um.
 * Reihenfolge des Rückgabearrays entspricht der Eingabe.
 */
export function buildGameHandicaps(courseHandicaps: number[], config: HandicapConfig = DEFAULT_HANDICAP_CONFIG): number[] {
  const values = courseHandicaps.map(value => (Number.isFinite(value) ? value : 0));
  if (!values.length) return [];
  if (config.mode === "gross") return values.map(() => 0);
  const percent = Number.isFinite(config.percent) ? config.percent : 100;
  const factor = percent / 100;
  if (config.mode === "difference") {
    const lowest = Math.min(...values);
    return values.map(value => Math.round((value - lowest) * factor));
  }
  return values.map(value => Math.round(value * factor));
}

export type Participant = {
  id: string;
  courseHandicap: number;
};

export type Allocation = {
  id: string;
  courseHandicap: number;
  gameHandicap: number;
  strokes: number[];
};

/** Komplette Vorgabenverteilung für alle Teilnehmer eines Spiels. */
export function buildAllocations(
  participants: Participant[],
  holes: HoleInfo[],
  config: HandicapConfig = DEFAULT_HANDICAP_CONFIG,
): Allocation[] {
  const gameHandicaps = buildGameHandicaps(participants.map(p => p.courseHandicap), config);
  return participants.map((participant, index) => ({
    id: participant.id,
    courseHandicap: participant.courseHandicap,
    gameHandicap: gameHandicaps[index],
    strokes: strokeAllocation(gameHandicaps[index], holes),
  }));
}

/** Bruttoschläge je Spieler und Loch: scores[holeIndex][playerId]. */
export type HoleScores = Record<string, number | null | undefined>;

function grossAt(scores: HoleScores[], holeIndex: number, playerId: string): number | null {
  const value = scores?.[holeIndex]?.[playerId];
  if (value === null || value === undefined) return null;
  // Leere Strings aus älteren gespeicherten Ständen laufen über parseInt auf NaN.
  const parsed = typeof value === "number" ? value : parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Nettoschläge eines Spielers auf einem Loch, oder null wenn nicht erfasst. */
export function netAt(
  scores: HoleScores[],
  holeIndex: number,
  allocation: Allocation | undefined,
): number | null {
  if (!allocation) return null;
  const gross = grossAt(scores, holeIndex, allocation.id);
  if (gross === null) return null;
  return gross - (allocation.strokes[holeIndex] ?? 0);
}

function allocationById(allocations: Allocation[]): Map<string, Allocation> {
  return new Map(allocations.map(allocation => [allocation.id, allocation]));
}

/** Anzahl der Löcher, auf denen mindestens ein Ergebnis erfasst ist. */
export function playedHoleCount(scores: HoleScores[], playerIds: string[], holeCount: number): number {
  let played = 0;
  for (let index = 0; index < holeCount; index += 1) {
    if (playerIds.some(id => grossAt(scores, index, id) !== null)) played += 1;
  }
  return played;
}

// ---------------------------------------------------------------------------
// Matchplay (Lochspiel, Einzel)
// ---------------------------------------------------------------------------

export type MatchplayHole = {
  holeIndex: number;
  netA: number | null;
  netB: number | null;
  winner: "a" | "b" | "halved" | null; // null = Loch noch nicht gespielt
  statusAfter: number; // positiv = A führt
  /** Loch wurde gespielt, obwohl das Match schon entschieden war ("Bagger"). */
  afterDecision: boolean;
};

export type MatchplayResult = {
  holes: MatchplayHole[];
  /** Aktueller Stand, positiv = A führt. */
  status: number;
  playedHoles: number;
  remainingHoles: number;
  decided: boolean;
  /** 0-basierter Index des Lochs, auf dem das Match entschieden war. */
  decidedAtHole: number | null;
  winner: "a" | "b" | null;
  complete: boolean;
  /** Laufender Stand, z.B. "2 auf" oder "A/S" – zweisprachig. */
  statusLabel: LangText;
  /** Endergebnis, z.B. "3 & 2" – null solange das Match offen ist. */
  resultLabel: LangText | null;
};

/**
 * Wertet ein Einzel-Lochspiel zwischen zwei Teilnehmern aus.
 * Das Match ist entschieden, sobald der Vorsprung größer ist als die Zahl der
 * verbleibenden Löcher. Danach eingetragene Löcher ("Bagger") verändern das
 * Ergebnis nicht mehr, werden aber weiter mitgeführt.
 */
export function scoreMatchplay(
  playerA: string,
  playerB: string,
  scores: HoleScores[],
  allocations: Allocation[],
  holes: HoleInfo[],
  /** Lochbereich [from, to) – für Nassau-Teilwetten. Standard: die ganze Runde. */
  range?: { from: number; to: number },
): MatchplayResult {
  const byId = allocationById(allocations);
  const allocA = byId.get(playerA);
  const allocB = byId.get(playerB);
  const from = Math.max(0, range?.from ?? 0);
  const to = Math.min(holes.length, range?.to ?? holes.length);
  const holeCount = Math.max(0, to - from);

  const result: MatchplayHole[] = [];
  let status = 0;
  let played = 0;
  let decidedAtHole: number | null = null;

  for (let index = from; index < to; index += 1) {
    const netA = netAt(scores, index, allocA);
    const netB = netAt(scores, index, allocB);
    const bothPlayed = netA !== null && netB !== null;
    const afterDecision = decidedAtHole !== null;

    let winner: MatchplayHole["winner"] = null;
    if (bothPlayed) {
      winner = netA < netB ? "a" : netB < netA ? "b" : "halved";
      if (!afterDecision) {
        played += 1;
        if (winner === "a") status += 1;
        else if (winner === "b") status -= 1;
      }
    }

    result.push({ holeIndex: index, netA, netB, winner, statusAfter: status, afterDecision });

    if (decidedAtHole === null && bothPlayed) {
      const remaining = to - (index + 1);
      if (Math.abs(status) > remaining) decidedAtHole = index;
    }
  }

  const remainingHoles = Math.max(0, holeCount - played);
  const decided = decidedAtHole !== null;
  const complete = holeCount > 0 && (decided || played === holeCount);
  const winner = complete && status !== 0 ? (status > 0 ? "a" : "b") : null;

  const lead = Math.abs(status);
  const statusLabel: LangText = status === 0
    ? { de: "A/S", en: "A/S" }
    : { de: `${lead} auf`, en: `${lead} up` };

  let resultLabel: LangText | null = null;
  if (complete) {
    if (status === 0) {
      resultLabel = { de: "Geteilt (A/S)", en: "Halved (A/S)" };
    } else {
      const holesLeft = to - ((decidedAtHole ?? to - 1) + 1);
      resultLabel = holesLeft > 0
        ? { de: `${lead} & ${holesLeft}`, en: `${lead} & ${holesLeft}` }
        : { de: `${lead} auf`, en: `${lead} up` };
    }
  }

  return {
    holes: result,
    status,
    playedHoles: played,
    remainingHoles,
    decided,
    decidedAtHole,
    winner,
    complete,
    statusLabel,
    resultLabel,
  };
}

// ---------------------------------------------------------------------------
// Skins
// ---------------------------------------------------------------------------

export type SkinsHole = {
  holeIndex: number;
  /** Skins, die auf diesem Loch im Topf lagen (inkl. Übertrag). */
  pot: number;
  winnerId: string | null;
  /** Kein alleiniger Sieger -> Topf wandert aufs nächste Loch. */
  carried: boolean;
  bestNet: number | null;
};

export type SkinsResult = {
  holes: SkinsHole[];
  /** Gewonnene Skins je Spieler-ID. */
  totals: Record<string, number>;
  /** Noch offener Übertrag am Ende der Runde. */
  openCarry: number;
};

/**
 * Skins: Jedes Loch ist einen Skin wert. Nur wer ein Loch alleine gewinnt,
 * kassiert – bei Gleichstand wächst der Topf aufs nächste Loch ("Carry-over").
 */
export function scoreSkins(
  playerIds: string[],
  scores: HoleScores[],
  allocations: Allocation[],
  holes: HoleInfo[],
): SkinsResult {
  const byId = allocationById(allocations);
  const totals: Record<string, number> = {};
  for (const id of playerIds) totals[id] = 0;

  const result: SkinsHole[] = [];
  let carry = 0;

  for (let index = 0; index < holes.length; index += 1) {
    const nets = playerIds
      .map(id => ({ id, net: netAt(scores, index, byId.get(id)) }))
      .filter((entry): entry is { id: string; net: number } => entry.net !== null);

    // Solange nicht alle Spieler erfasst sind, ist das Loch noch offen.
    if (nets.length < playerIds.length || playerIds.length < 2) {
      result.push({ holeIndex: index, pot: carry + 1, winnerId: null, carried: false, bestNet: null });
      continue;
    }

    const bestNet = Math.min(...nets.map(entry => entry.net));
    const leaders = nets.filter(entry => entry.net === bestNet);
    const pot = carry + 1;

    if (leaders.length === 1) {
      const winnerId = leaders[0].id;
      totals[winnerId] += pot;
      carry = 0;
      result.push({ holeIndex: index, pot, winnerId, carried: false, bestNet });
    } else {
      carry = pot;
      result.push({ holeIndex: index, pot, winnerId: null, carried: true, bestNet });
    }
  }

  return { holes: result, totals, openCarry: carry };
}

// ---------------------------------------------------------------------------
// Nassau
// ---------------------------------------------------------------------------

export type NassauPress = {
  /** 0-basiertes Loch, ab dem die Zusatzwette läuft. */
  from: number;
  /** Segment, dessen Restlöcher bespielt werden. */
  segment: "front" | "back" | "total";
};

export type NassauBet = {
  key: string;
  label: LangText;
  from: number;
  to: number;
  press: boolean;
  result: MatchplayResult;
};

export type NassauResult = {
  bets: NassauBet[];
  /** Gewonnene Wetten je Seite. */
  totals: { a: number; b: number };
};

/** Grundsegmente einer Nassau-Runde. Unter 18 Löchern gibt es nur eine Wette. */
export function nassauSegments(holeCount: number): { key: NassauPress["segment"]; label: LangText; from: number; to: number }[] {
  if (holeCount < 18) return [{ key: "total", label: { de: "Gesamt", en: "Total" }, from: 0, to: holeCount }];
  return [
    { key: "front", label: { de: "Front 9", en: "Front 9" }, from: 0, to: 9 },
    { key: "back", label: { de: "Back 9", en: "Back 9" }, from: 9, to: 18 },
    { key: "total", label: { de: "Gesamt", en: "Total" }, from: 0, to: 18 },
  ];
}

/**
 * Nassau: Front 9, Back 9 und Gesamt sind drei getrennte Lochspiele. Ein Press
 * eröffnet eine zusätzliche Wette über die Restlöcher seines Segments und wird
 * bewusst nur manuell gesetzt.
 */
export function scoreNassau(
  playerA: string,
  playerB: string,
  scores: HoleScores[],
  allocations: Allocation[],
  holes: HoleInfo[],
  presses: NassauPress[] = [],
): NassauResult {
  const segments = nassauSegments(holes.length);
  const bets: NassauBet[] = segments.map(segment => ({
    key: segment.key,
    label: segment.label,
    from: segment.from,
    to: segment.to,
    press: false,
    result: scoreMatchplay(playerA, playerB, scores, allocations, holes, { from: segment.from, to: segment.to }),
  }));

  for (const press of presses) {
    const segment = segments.find(entry => entry.key === press.segment);
    if (!segment) continue;
    const from = Math.max(segment.from, press.from);
    if (from >= segment.to) continue;
    bets.push({
      key: `${press.segment}-press-${from}`,
      label: { de: `${segment.label.de} Press ab Loch ${from + 1}`, en: `${segment.label.en} press from hole ${from + 1}` },
      from,
      to: segment.to,
      press: true,
      result: scoreMatchplay(playerA, playerB, scores, allocations, holes, { from, to: segment.to }),
    });
  }

  const totals = { a: 0, b: 0 };
  for (const bet of bets) {
    if (!bet.result.complete || !bet.result.winner) continue;
    totals[bet.result.winner] += 1;
  }

  return { bets, totals };
}

// ---------------------------------------------------------------------------
// Wolf
// ---------------------------------------------------------------------------

export type WolfChoice = {
  /** Gewählter Partner, oder null für allein. */
  partnerId?: string | null;
  /** Blind Wolf ("Pig"): schon vor dem ersten Abschlag allein angesagt. */
  blind?: boolean;
  /** Allein angesagt. Ohne Partner und ohne dieses Zeichen ist nichts gewählt. */
  lone?: boolean;
};

export type WolfHole = {
  holeIndex: number;
  wolfId: string | null;
  /**
   * Hat der Wolf sich erklärt? Ohne Ansage gibt es keine Punkte: sonst wäre
   * jedes vergessene Loch ein Lone Wolf, und den zahlt keiner gern aus
   * Versehen.
   */
  declared: boolean;
  partnerId: string | null;
  lone: boolean;
  blind: boolean;
  wolfTeam: string[];
  opponents: string[];
  wolfBest: number | null;
  opponentBest: number | null;
  outcome: "wolf" | "opponents" | "halved" | null;
  points: Record<string, number>;
};

export type WolfResult = {
  holes: WolfHole[];
  totals: Record<string, number>;
  /** Löcher, auf denen nicht mehr rotiert, sondern nach Punktstand bestimmt wird. */
  rotationHoles: number;
  /** Gespielte Löcher ohne Ansage des Wolfs – dort fehlen die Punkte. */
  undeclared: number[];
};

/**
 * Wolf. Die Abschlagreihenfolge rotiert, der Wolf wählt nach den Abschlägen
 * einen Partner oder spielt allein.
 *
 * Punkte:
 *   Wolf + Partner gewinnen -> beide je 1
 *   Gegenseite gewinnt      -> jeder Gegner je 1
 *   Lone Wolf gewinnt       -> 3   (Blind Wolf: 4)
 *   Lone Wolf verliert      -> jeder andere je 1   (Blind Wolf: je 2)
 *   Geteiltes Loch          -> keine Punkte
 *   Ohne Ansage             -> keine Punkte, das Loch bleibt offen
 *
 * Die Ansage ist Pflicht: der Wolf sagt vor dem Loch, mit wem er spielt. Ein
 * Loch ohne Ansage wird deshalb nicht gewertet, statt stillschweigend als Lone
 * Wolf durchzugehen – 3 Punkte, die niemand angesagt hat, wären teuer.
 *
 * Die Rotation geht nur so lange auf, wie die Lochzahl durch die Spielerzahl
 * teilbar ist. Für die Restlöcher (bei vier Spielern also 17 und 18) ist der
 * Spieler mit den wenigsten Punkten Wolf.
 */
export function scoreWolf(
  playerIds: string[],
  scores: HoleScores[],
  allocations: Allocation[],
  holes: HoleInfo[],
  choices: WolfChoice[] = [],
): WolfResult {
  const byId = allocationById(allocations);
  const playerCount = playerIds.length;
  const holeCount = holes.length;
  const totals: Record<string, number> = {};
  for (const id of playerIds) totals[id] = 0;

  const rotationHoles = playerCount > 0 ? Math.floor(holeCount / playerCount) * playerCount : 0;
  const result: WolfHole[] = [];
  const undeclared: number[] = [];

  for (let index = 0; index < holeCount; index += 1) {
    if (playerCount < 3) {
      result.push({
        holeIndex: index, wolfId: null, declared: false, partnerId: null, lone: false, blind: false,
        wolfTeam: [], opponents: [], wolfBest: null, opponentBest: null, outcome: null, points: {},
      });
      continue;
    }

    const wolfId = index < rotationHoles
      ? playerIds[index % playerCount]
      // Restlöcher: schlechtester Punktstand wird Wolf, bei Gleichstand der
      // in der Abschlagreihenfolge frühere Spieler.
      : playerIds.reduce((worst, id)=>(totals[id] < totals[worst] ? id : worst), playerIds[0]);

    const choice = choices[index] || {};
    const partnerId = choice.partnerId && choice.partnerId !== wolfId && playerIds.includes(choice.partnerId)
      ? choice.partnerId
      : null;
    // Allein gilt nur als angesagt, wenn es angesagt wurde. Ein leerer Eintrag
    // ist ein offenes Loch, kein Lone Wolf.
    const declared = partnerId !== null || Boolean(choice.lone) || Boolean(choice.blind);
    const lone = declared && partnerId === null;
    const blind = lone && Boolean(choice.blind);

    const wolfTeam = declared ? (lone ? [wolfId] : [wolfId, partnerId as string]) : [];
    const opponents = declared ? playerIds.filter(id=>!wolfTeam.includes(id)) : [];

    const bestNet = (ids: string[]) => {
      const nets = ids.map(id=>netAt(scores, index, byId.get(id))).filter((net): net is number => net !== null);
      return nets.length === ids.length && nets.length > 0 ? Math.min(...nets) : null;
    };
    const wolfBest = bestNet(wolfTeam);
    const opponentBest = bestNet(opponents);

    // Ein Loch, das schon gespielt ist, aber ohne Ansage blieb, faellt auf.
    if (!declared && playerIds.every(id=>netAt(scores, index, byId.get(id)) !== null)) {
      undeclared.push(index);
    }

    let outcome: WolfHole["outcome"] = null;
    const points: Record<string, number> = {};
    if (wolfBest !== null && opponentBest !== null) {
      if (wolfBest < opponentBest) {
        outcome = "wolf";
        if (lone) points[wolfId] = blind ? 4 : 3;
        else for (const id of wolfTeam) points[id] = 1;
      } else if (opponentBest < wolfBest) {
        outcome = "opponents";
        const award = lone ? (blind ? 2 : 1) : 1;
        for (const id of opponents) points[id] = award;
      } else {
        outcome = "halved";
      }
      for (const [id, value] of Object.entries(points)) totals[id] += value;
    }

    result.push({ holeIndex: index, wolfId, declared, partnerId, lone, blind, wolfTeam, opponents, wolfBest, opponentBest, outcome, points });
  }

  return { holes: result, totals, rotationHoles, undeclared };
}

// ---------------------------------------------------------------------------
// Bingo Bango Bongo
// ---------------------------------------------------------------------------

export type BbbAwards = {
  /** Zuerst auf dem Grün. */
  bingo?: string | null;
  /** Am nächsten zur Fahne, sobald alle auf dem Grün liegen. */
  bango?: string | null;
  /** Zuerst eingelocht. */
  bongo?: string | null;
};

export const BBB_AWARDS: { key: keyof BbbAwards; label: string; hint: LangText }[] = [
  { key: "bingo", label: "Bingo", hint: { de: "zuerst auf dem Grün", en: "first on the green" } },
  { key: "bango", label: "Bango", hint: { de: "am nächsten zur Fahne", en: "closest to the pin" } },
  { key: "bongo", label: "Bongo", hint: { de: "zuerst eingelocht", en: "first in the hole" } },
];

export type BbbResult = {
  holes: { holeIndex: number; awards: BbbAwards; points: number }[];
  totals: Record<string, number>;
  /** Zählung je Kategorie, für die Auswertung nach der Runde. */
  byAward: Record<string, { bingo: number; bango: number; bongo: number }>;
};

/**
 * Bingo Bango Bongo: drei Punkte pro Loch, die sich nicht aus der Schlagzahl
 * ableiten lassen und deshalb direkt erfasst werden.
 */
export function scoreBingoBangoBongo(
  playerIds: string[],
  awards: BbbAwards[],
  holeCount: number,
): BbbResult {
  const totals: Record<string, number> = {};
  const byAward: BbbResult["byAward"] = {};
  for (const id of playerIds) {
    totals[id] = 0;
    byAward[id] = { bingo: 0, bango: 0, bongo: 0 };
  }

  const holes: BbbResult["holes"] = [];
  for (let index = 0; index < holeCount; index += 1) {
    const entry = awards[index] || {};
    let points = 0;
    for (const award of BBB_AWARDS) {
      const winner = entry[award.key];
      if (!winner || !playerIds.includes(winner)) continue;
      totals[winner] += 1;
      byAward[winner][award.key] += 1;
      points += 1;
    }
    holes.push({ holeIndex: index, awards: entry, points });
  }

  return { holes, totals, byAward };
}

// ---------------------------------------------------------------------------
// Ableitung einer HCP-wirksamen Runde aus den Loch-Scores
// ---------------------------------------------------------------------------

export type StablefordSummary = {
  grossTotal: number;
  netPoints: number;
  holesCounted: number;
  complete: boolean;
};

/**
 * Netto-Stableford aus den Bruttoschlägen eines Spielers – Grundlage für die
 * Übernahme einer Games-Runde in den HCP-Tracker. Erwartet die Vorgabenschläge
 * aus dem vollen Course Handicap (Modus "full", 100%), nicht die
 * Lochspiel-Differenz.
 */
export function stablefordFromHoles(
  playerId: string,
  scores: HoleScores[],
  allocation: Allocation | undefined,
  holes: HoleInfo[],
): StablefordSummary {
  let grossTotal = 0;
  let netPoints = 0;
  let holesCounted = 0;

  for (let index = 0; index < holes.length; index += 1) {
    const gross = grossAt(scores, index, playerId);
    if (gross === null || !allocation) continue;
    holesCounted += 1;
    grossTotal += gross;
    const net = gross - (allocation.strokes[index] ?? 0);
    netPoints += Math.max(0, holes[index].par - net + 2);
  }

  return { grossTotal, netPoints, holesCounted, complete: holesCounted === holes.length };
}
