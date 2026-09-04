export type TurnRegionKind = "mermaid" | "d2" | "table" | "list" | "heading";

export type TurnRegion = {
  kind: TurnRegionKind;
  sourceStart: number;
  sourceEnd: number;
  text: string;
};

export type ProjectedTurnRegion = TurnRegion & {
  id: string;
  turnId: string;
  bufferStart: number;
  bufferEnd: number;
  sourceBufferRows?: Array<number | null>;
};

type RegionRowMatch = { source_row: number; row: { text: string; start: number; end: number } };

export function alignRegionRows(
  source: string[],
  rows: Array<{ text: string; start: number; end: number }>,
  normalize: (line: string) => string,
): RegionRowMatch[] {
  const left = source.map(normalize);
  const right = rows.map((row) => normalize(row.text));
  const score = (source_line: string, screen_line: string) => {
    if (source_line.length < 3 || screen_line.length < 3) return 0;
    if (source_line === screen_line) return 10_000 + source_line.length;
    if (source_line.length >= 8 && screen_line.length >= 8 &&
        (screen_line.includes(source_line) || source_line.includes(screen_line))) {
      return 100 + Math.min(source_line.length, screen_line.length);
    }
    return 0;
  };
  const width = right.length + 1;
  const values = new Int32Array((left.length + 1) * width);
  for (let source_row = 1; source_row <= left.length; source_row++) {
    for (let screen_row = 1; screen_row <= right.length; screen_row++) {
      const cell = source_row * width + screen_row;
      const matched = score(left[source_row - 1], right[screen_row - 1]);
      values[cell] = Math.max(
        values[(source_row - 1) * width + screen_row],
        values[source_row * width + screen_row - 1],
        matched ? values[(source_row - 1) * width + screen_row - 1] + matched : 0,
      );
    }
  }
  const matches: RegionRowMatch[] = [];
  let source_row = left.length;
  let screen_row = right.length;
  while (source_row && screen_row) {
    const cell = source_row * width + screen_row;
    const matched = score(left[source_row - 1], right[screen_row - 1]);
    if (matched && values[cell] === values[(source_row - 1) * width + screen_row - 1] + matched) {
      matches.push({ source_row: source_row - 1, row: rows[screen_row - 1] });
      source_row--;
      screen_row--;
    } else if (values[cell] === values[(source_row - 1) * width + screen_row]) {
      source_row--;
    } else {
      screen_row--;
    }
  }
  return matches.reverse();
}

const fence = /^\s*(`{3,}|~{3,})\s*(mermaid|d2)\s*$/i;
const anyFence = /^\s*(`{3,}|~{3,})/;
const tableSeparator = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+(?:\s*:?-{3,}:?\s*)\|?\s*$/;
const tableRow = /^\s*\|.*\|\s*$/;
const listRow = /^\s*(?:[-+*]|\d+[.)])\s+\S/;
/// An ATX heading, or a line that is nothing but a bold run (how a harness
/// titles a section when it skips `#`), optionally ending in a colon.
const headingRow = /^\s*(?:#{1,6}\s+\S|\*\*[^*]+\*\*:?\s*$)/;

export function detectTurnRegions(said: string): TurnRegion[] {
  const lines = said.split("\n");
  const regions: TurnRegion[] = [];
  const occupied = new Set<number>();
  for (let start = 0; start < lines.length; start++) {
    const boundary = lines[start].match(anyFence);
    if (!boundary) continue;
    const end = lines.findIndex((line, index) => index > start &&
      new RegExp(`^\\s*${boundary[1][0]}{${boundary[1].length},}\\s*$`).test(line));
    if (end < 0) continue;
    const open = lines[start].match(fence);
    if (open) {
      regions.push({
        kind: open[2].toLowerCase() as "mermaid" | "d2",
        sourceStart: start,
        sourceEnd: end,
        text: lines.slice(start + 1, end).join("\n"),
      });
    }
    for (let index = start; index <= end; index++) occupied.add(index);
    start = end;
  }
  for (let index = 1; index < lines.length; index++) {
    if (occupied.has(index - 1) || occupied.has(index) || !tableRow.test(lines[index - 1]) || !tableSeparator.test(lines[index])) continue;
    let end = index + 1;
    while (end < lines.length && tableRow.test(lines[end])) end++;
    regions.push({ kind: "table", sourceStart: index - 1, sourceEnd: end - 1, text: lines.slice(index - 1, end).join("\n") });
    for (let row = index - 1; row < end; row++) occupied.add(row);
    index = end - 1;
  }
  for (let index = 0; index < lines.length; index++) {
    if (occupied.has(index) || !headingRow.test(lines[index])) continue;
    regions.push({ kind: "heading", sourceStart: index, sourceEnd: index, text: lines[index] });
    occupied.add(index);
  }
  for (let start = 0; start < lines.length; start++) {
    if (occupied.has(start) || !listRow.test(lines[start])) continue;
    let end = start + 1;
    while (end < lines.length && !occupied.has(end) && (listRow.test(lines[end]) || /^\s{2,}\S/.test(lines[end]))) end++;
    regions.push({ kind: "list", sourceStart: start, sourceEnd: end - 1, text: lines.slice(start, end).join("\n") });
    start = end - 1;
  }
  return regions.sort((a, b) => a.sourceStart - b.sourceStart || a.sourceEnd - b.sourceEnd);
}

export function projectTurnRegions(
  turnId: string,
  said: string,
  turnSpan: { bufferStart: number; bufferEnd: number },
  rows: Array<{ text: string; start: number; end: number }>,
  normalize: (line: string) => string,
): ProjectedTurnRegion[] {
  return detectTurnRegions(said).flatMap((region) => {
    const anchors = said.split("\n").slice(region.sourceStart, region.sourceEnd + 1);
    const matches = alignRegionRows(anchors, rows, normalize);
    if (!matches.length) return [];
    const sourceBufferRows: Array<number | null> = anchors.map(() => null);
    for (const match of matches) sourceBufferRows[match.source_row] = match.row.start;
    const bufferStart = Math.max(turnSpan.bufferStart, Math.min(...matches.map((match) => match.row.start)));
    const bufferEnd = Math.min(turnSpan.bufferEnd, Math.max(...matches.map((match) => match.row.end)));
    return [{
      ...region,
      id: `${turnId}:${region.kind}:${region.sourceStart}`,
      turnId,
      bufferStart,
      bufferEnd: Math.max(bufferStart, bufferEnd),
      sourceBufferRows,
    }];
  });
}

export function regionAtBufferRow(regions: ProjectedTurnRegion[], row: number): ProjectedTurnRegion | null {
  return regions.find((region) => region.bufferStart <= row && row <= region.bufferEnd) ?? null;
}
