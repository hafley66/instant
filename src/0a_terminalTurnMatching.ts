import type { LogicalLine } from "./00a_terminalIntersection";
import type { BoopTurn, VisibleTurn } from "./0_terminalTurnVisibility";

export type TurnMatch = {
  source: { turn: BoopTurn; id: string; normalized: string[] };
  hits: Array<LogicalLine & { sourceIndex: number }>;
  sourceSpan: number;
};

const characterCount = (text: string) => [...text].length;

export function normalizeTurnLine(line: string): string {
  const lowered = line.toLowerCase();
  const hasCardGutter = /^\s*│/.test(lowered);
  const content = lowered.replace(/^\s*[│┃┆┊╎╏┌└├┬╭╰>*•●◉⏺⏵◆›❯»▶🭬✨✳✻⎿━─┏┓┗┛┠┨┯┷┼╂╄╅╆╇╈╉╊═║╔╗╚╝╠╣╦╩╬]+\s*/, "");
  return (hasCardGutter ? content.replace(/^\$\s*/, "") : content)
    .replace(/[`_*~#]/g, "")
    .replace(/[━─┏┓┗┛┠┨┯┷┼╂╄╅╆╇╈╉╊═║╔╗╚╝╠╣╦╩╬|│┃┆┊╎╏┌┐└┘├┤┬┴]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function sourceLines(turn: BoopTurn): string[] {
  const [toolName, argumentsJson, ...rest] = turn.said.split("\n");
  if (turn.role !== "tool" || !toolName || !argumentsJson || rest.length) return turn.said.split("\n");
  try {
    const argumentsValue: unknown = JSON.parse(argumentsJson);
    if (typeof argumentsValue === "object" && argumentsValue !== null
      && "command" in argumentsValue && typeof argumentsValue.command === "string") {
      return [toolName, ...argumentsValue.command.split("\n")];
    }
  } catch {}
  return turn.said.split("\n");
}

export function lineMatches(screen: string, source: string): boolean {
  const screenLength = characterCount(screen);
  const sourceLength = characterCount(source);
  return screen === source || sourceLength >= 8 && (
    screen.includes(source) && sourceLength * 2 >= screenLength
    || source.includes(screen) && screenLength >= 12
  );
}

export function monotonicTurnMatch(
  screen: Array<LogicalLine & { normalized: string }>,
  source: TurnMatch["source"],
): TurnMatch | null {
  const rows = screen.filter((row) => row.normalized);
  const scores = Array.from({ length: rows.length + 1 }, () => new Uint32Array(source.normalized.length + 1));
  for (let row = 1; row <= rows.length; row += 1) {
    for (let column = 1; column <= source.normalized.length; column += 1) {
      const matchScore = lineMatches(rows[row - 1].normalized, source.normalized[column - 1])
        ? scores[row - 1][column - 1] + 1000
          + Math.min(characterCount(rows[row - 1].normalized), characterCount(source.normalized[column - 1]))
        : 0;
      scores[row][column] = Math.max(matchScore, scores[row - 1][column], scores[row][column - 1]);
    }
  }
  if (scores[rows.length][source.normalized.length] === 0) return null;
  const hits: TurnMatch["hits"] = [];
  let row = rows.length;
  let column = source.normalized.length;
  while (row > 0 && column > 0) {
    if (lineMatches(rows[row - 1].normalized, source.normalized[column - 1])
      && scores[row][column] === scores[row - 1][column - 1] + 1000
        + Math.min(characterCount(rows[row - 1].normalized), characterCount(source.normalized[column - 1]))) {
      hits.push({ ...rows[row - 1], sourceIndex: column - 1 });
      row -= 1;
      column -= 1;
    } else if (scores[row - 1][column] >= scores[row][column - 1]) row -= 1;
    else column -= 1;
  }
  hits.reverse();
  return { source, hits, sourceSpan: hits[hits.length - 1].sourceIndex - hits[0].sourceIndex + 1 };
}

export function matchRowOwners(matches: TurnMatch[]): Map<string, number> {
  const owners = new Map<string, Set<string>>();
  for (const match of matches) for (const hit of match.hits) {
    const key = `${hit.start}:${match.source.turn.role}`;
    const claimed = owners.get(key) ?? new Set<string>();
    claimed.add(match.source.id);
    owners.set(key, claimed);
  }
  return new Map([...owners].map(([key, sources]) => [key, sources.size]));
}

export function hasDiscriminatingHit(
  hits: TurnMatch["hits"],
  screen: Array<LogicalLine & { normalized: string }>,
  source: TurnMatch["source"],
  owners: Map<string, number>,
): boolean {
  return hits.some((hit) => {
    const row = screen.find((candidate) => candidate.start === hit.start);
    if (!row) return false;
    const unambiguous = owners.get(`${hit.start}:${source.turn.role}`) === 1;
    return source.turn.role === "tool"
      ? unambiguous && characterCount(row.normalized) >= 8
      : unambiguous || source.turn.role === "user" && row.text.trimStart().startsWith("❯");
  });
}

export function growAnchors(
  visible: VisibleTurn[],
  screen: Array<LogicalLine & { normalized: string }>,
  sources: TurnMatch["source"][],
) {
  const rows = screen.filter((row) => row.normalized);
  const anchored = new Map(visible.map((turn) => [turn.id, turn]));
  const ownerAt = new Map<number, string>();
  for (const turn of visible) for (const row of rows) {
    if (row.start >= turn.anchorStart && row.end <= turn.anchorEnd) ownerAt.set(row.start, turn.id);
  }
  for (const [id, turn] of anchored) {
    const source = sources.find((candidate) => candidate.id === id);
    if (!source) continue;
    const claims = (row: LogicalLine & { normalized: string }) =>
      (ownerAt.get(row.start) ?? id) === id && source.normalized.some((line) => lineMatches(row.normalized, line));
    const first = rows.findIndex((row) => row.start >= turn.anchorStart);
    if (first < 0) continue;
    let low = first;
    while (low > 0 && claims(rows[low - 1])) low -= 1;
    let high = rows.findIndex((row) => row.end >= turn.anchorEnd);
    if (high < 0) high = rows.length - 1;
    while (high + 1 < rows.length && claims(rows[high + 1])) high += 1;
    turn.anchorStart = Math.min(turn.anchorStart, rows[low].start);
    turn.anchorEnd = Math.max(turn.anchorEnd, rows[high].end);
    turn.bufferStart = turn.anchorStart;
    turn.bufferEnd = turn.anchorEnd;
    for (let index = low; index <= high; index += 1) ownerAt.set(rows[index].start, id);
  }
}
