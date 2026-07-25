// Where a ⌘-clickable token starts and ends on one line of text. One scanner
// backs all three call sites (the xterm link provider's hover underline, the
// terminal hover card, and ⌘-click on DOM text), so the highlighted span, the
// card's token, and the dispatched token are always the same characters.
//
// The shapes that matter here come from agent output, which wraps its paths in
// a call-looking envelope (`Update(src/main.ts)`, `Read(src/a.ts:12)`) or in
// markdown (`[main.ts](src/main.ts)`, `` `src/main.ts` ``). Highlighting the
// envelope along with the path is the bug this module exists to prevent: the
// span must stop at the path.

export type TokenSpan = {
  // Token text with the envelope removed (what gets dispatched/resolved).
  text: string;
  // 0-based half-open column range of `text` within the scanned line, so a
  // caller can both hit-test a column and draw a highlight over exactly it.
  start: number;
  end: number;
};

// Openers stripped from the front of a bare whitespace-run token, and the
// punctuation eligible to come off the back.
const LEAD = /^[('"`<[{]+/;
const TRAIL_CHAR = /[.,;:!?)\]}>'"`]/;
const CLOSER_OPENER: Record<string, string> = { ")": "(", "]": "[", "}": "{", ">": "<" };

// `Ident(inner)` / `Ident[inner]` — a tool-call envelope in agent transcripts.
// The identifier may carry dots and dashes (`fs.readFile(...)`, `Bash-run(...)`).
// Anchored to the whole run, so a real path containing parens is left alone.
const CALL = /^([A-Za-z_$][\w.$-]*)\(([^()]*)\)$/;
const CALL_SQUARE = /^([A-Za-z_$][\w.$-]*)\[([^\][]*)\]$/;

// `[label](target)` — a markdown link. The target is the openable half.
const MD_LINK = /^\[([^\]]*)\]\(([^()]*)\)$/;

// A `path:line` / `path:line:col` suffix stays part of the token: the preview
// tab uses it to scroll to the row.
const LINE_SUFFIX = /:(\d+)(?::\d+)?$/;

// Peel one envelope layer off `text` (already narrowed to a whitespace run),
// returning the inner span as an offset into `text`. Returns null when the run
// carries no envelope.
function peel(text: string): { inner: string; offset: number } | null {
  const md = text.match(MD_LINK);
  if (md) return { inner: md[2], offset: md[0].length - 1 - md[2].length };
  const call = text.match(CALL) ?? text.match(CALL_SQUARE);
  if (call) return { inner: call[2], offset: call[1].length + 1 };
  const lead = text.match(LEAD)?.[0].length ?? 0;
  const end = trailingPunctuationAt(text, lead);
  if (!lead && end === text.length) return null;
  const inner = text.slice(lead, end);
  return inner ? { inner, offset: lead } : null;
}

// Where the token's own text ends, walking trailing punctuation off one
// character at a time. A closer survives when the token carries an opener for
// it, so a url like `https://host/a(b)` keeps its paren while a sentence tail
// like `see src/main.ts).` loses both.
function trailingPunctuationAt(text: string, lead: number): number {
  let end = text.length;
  while (end > lead) {
    const ch = text[end - 1];
    if (!TRAIL_CHAR.test(ch)) break;
    const opener = CLOSER_OPENER[ch];
    if (opener) {
      const body = text.slice(lead, end);
      const closes = body.split(ch).length - 1;
      const opens = body.split(opener).length - 1;
      if (opens >= closes) break;
    }
    end--;
  }
  return end;
}

// Strip every envelope layer, tracking the column offset so the span still
// points at the original line. Bounded, since each pass must shrink the run.
export function unwrapToken(raw: string): { text: string; offset: number } {
  let text = raw;
  let offset = 0;
  for (let guard = 0; guard < 8; guard++) {
    const peeled = peel(text);
    if (!peeled || peeled.inner === text) break;
    offset += peeled.offset;
    text = peeled.inner;
  }
  return { text, offset };
}

// Every ⌘-clickable span on `line`, left to right, non-overlapping.
// Quoted spans win over the whitespace runs they contain, so a path with
// spaces stays one token.
export function scanLineTokens(line: string): TokenSpan[] {
  const spans: TokenSpan[] = [];
  const quoted: Array<{ open: number; close: number }> = [];
  for (const m of line.matchAll(/(['"`])(.+?)\1/g)) {
    const inner = m[2];
    if (!inner.trim()) continue;
    const open = m.index ?? 0;
    quoted.push({ open, close: open + m[0].length - 1 });
    spans.push({ text: inner, start: open + 1, end: open + 1 + inner.length });
  }
  for (const m of line.matchAll(/\S+/g)) {
    const at = m.index ?? 0;
    if (quoted.some((q) => at >= q.open && at <= q.close)) continue;
    const { text, offset } = unwrapToken(m[0]);
    if (!text) continue;
    spans.push({ text, start: at + offset, end: at + offset + text.length });
  }
  spans.sort((a, b) => a.start - b.start);
  return spans;
}

// The span covering `col` (0-based), or null. Used by the hover card and the
// ⌘-click miss path so both agree with the underline the link provider drew.
export function tokenAtColumn(line: string, col: number): TokenSpan | null {
  return scanLineTokens(line).find((s) => col >= s.start && col < s.end) ?? null;
}

// Split a `path:line:col` token into its parts. `path` keeps whatever form the
// token had (absolute, relative, bare name); resolution happens in refResolve.
export function splitLineRef(token: string): { path: string; line?: number } {
  const m = token.match(LINE_SUFFIX);
  if (!m) return { path: token };
  const path = token.slice(0, m.index);
  // `C:\src` style drive letters and `http://host:8080` are not line refs.
  if (!path || /^[A-Za-z]$/.test(path) || /:\/\/[^/]*$/.test(path)) return { path: token };
  return { path, line: Number(m[1]) };
}
