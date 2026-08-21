export type TurnRegionKind = "mermaid" | "d2" | "table" | "list";

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
};

const fence = /^\s*(`{3,}|~{3,})\s*(mermaid|d2)\s*$/i;
const tableSeparator = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+(?:\s*:?-{3,}:?\s*)\|?\s*$/;
const tableRow = /^\s*\|.*\|\s*$/;
const listRow = /^\s*(?:[-+*]|\d+[.)])\s+\S/;

export function detectTurnRegions(said: string): TurnRegion[] {
  const lines = said.split("\n");
  const regions: TurnRegion[] = [];
  const occupied = new Set<number>();
  for (let start = 0; start < lines.length; start++) {
    const open = lines[start].match(fence);
    if (!open) continue;
    const end = lines.findIndex((line, index) => index > start && new RegExp(`^\\s*${open[1][0]}{${open[1].length},}\\s*$`).test(line));
    if (end < 0) continue;
    regions.push({
      kind: open[2].toLowerCase() as "mermaid" | "d2",
      sourceStart: start,
      sourceEnd: end,
      text: lines.slice(start + 1, end).join("\n"),
    });
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
  const source = said.split("\n").map(normalize);
  return detectTurnRegions(said).flatMap((region) => {
    const anchors = source.slice(region.sourceStart, region.sourceEnd + 1);
    const hits = rows.flatMap((row) => {
      const normalized = normalize(row.text);
      return anchors.flatMap((anchor, relative) => anchor.length >= 3 && (
        normalized === anchor || normalized.includes(anchor)
      ) ? [{ row, relative, exact: normalized === anchor, offset: row.start - relative, weight: anchor.length }] : []);
    });
    if (!hits.length) return [];
    const offsets = new Map<number, { count: number; exact: number; weight: number }>();
    for (const hit of hits) {
      const score = offsets.get(hit.offset) ?? { count: 0, exact: 0, weight: 0 };
      score.count++;
      score.exact += Number(hit.exact);
      score.weight += hit.weight;
      offsets.set(hit.offset, score);
    }
    const projectedStart = [...offsets].sort(([leftOffset, left], [rightOffset, right]) =>
      right.count - left.count || right.exact - left.exact || right.weight - left.weight || leftOffset - rightOffset
    )[0][0];
    // Physical xterm wraps only move later source rows downward. Keep those
    // matches when extending the region, while excluding unrelated occurrences
    // above the chosen source-to-buffer alignment.
    const aligned = hits.filter((hit) => hit.offset >= projectedStart);
    const last = aligned.reduce((right, hit) => hit.relative > right.relative ? hit : right);
    const bufferStart = Math.max(turnSpan.bufferStart, projectedStart);
    const missingAfter = region.sourceEnd - region.sourceStart - last.relative;
    const bufferEnd = Math.min(turnSpan.bufferEnd, last.row.end + missingAfter);
    return [{
      ...region,
      id: `${turnId}:${region.kind}:${region.sourceStart}`,
      turnId,
      bufferStart,
      bufferEnd: Math.max(bufferStart, bufferEnd),
    }];
  });
}

export function regionAtBufferRow(regions: ProjectedTurnRegion[], row: number): ProjectedTurnRegion | null {
  return regions.find((region) => region.bufferStart <= row && row <= region.bufferEnd) ?? null;
}
