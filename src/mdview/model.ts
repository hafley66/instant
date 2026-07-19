// Pure markdown section model for the mdview panel: parse once with
// remark-parse, then expose a heading tree whose nodes carry source offsets.
// The panel slices each section's own body out of the original text and feeds
// those slices to react-markdown per section — GFM fidelity per chunk without
// a custom renderer tree. No app imports here: this module is unit-tested in
// isolation (model.test.ts).
import { unified } from "unified";
import remarkParse from "remark-parse";
import type { Heading, PhrasingContent, Root } from "mdast";

export interface MdSection {
  id: string; // slug of the title, deduped ("usage", "usage-1", …)
  depth: number; // heading level 1-6
  title: string; // plain text (inline markdown stripped)
  start: number; // offset of the heading's first char in the source
  ownStart: number; // offset just past the heading (start of the own body)
  ownEnd: number; // first child's start, else `end`
  end: number; // next same-or-shallower heading's start, else EOF
  children: MdSection[];
}

export interface MdDoc {
  tree: MdSection[];
  preamble: string; // source before the first heading ("" when only whitespace)
  byId: Map<string, MdSection>;
  folds: ListFolds; // foldable lists / multi-block list items (VSCode-style)
}

export interface ListFolds {
  lists: Map<number, number>; // list start offset -> direct item count (≥2 items)
  firstItemToList: Map<number, number>; // a list's first item start -> list start (twisty handle)
  items: Set<number>; // multi-block listItem start offsets (foldable items)
  all: number[]; // every foldable offset (for "fold all")
}

// VSCode's markdown folding lets a list collapse to its first line and folds
// long (multi-block) list items. Offsets are the identity: stable across
// renders, unique per occurrence (unlike text), and absolute in the source —
// section slices re-base them by adding the slice's start offset.
function computeListFolds(root: Root): ListFolds {
  const lists = new Map<number, number>();
  const firstItemToList = new Map<number, number>();
  const items = new Set<number>();
  const visit = (node: { type: string; position?: { start: { offset?: number } }; children?: unknown[] }) => {
    if (node.type === "list") {
      const kids = (node.children ?? []) as typeof node[];
      const start = node.position?.start.offset;
      if (kids.length >= 2 && start != null) {
        lists.set(start, kids.length);
        const firstStart = kids[0]?.position?.start.offset;
        if (firstStart != null) firstItemToList.set(firstStart, start);
      }
    } else if (node.type === "listItem") {
      const blocks = (node.children ?? []).length;
      const start = node.position?.start.offset;
      if (blocks >= 2 && start != null) items.add(start);
    }
    for (const c of (node.children ?? []) as typeof node[]) visit(c);
  };
  visit(root as unknown as Parameters<typeof visit>[0]);
  return { lists, firstItemToList, items, all: [...lists.keys(), ...items] };
}

// GitHub-ish slug: lowercase, drop punctuation, whitespace/underscores -> "-".
export function slugify(title: string): string {
  const s = title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/[\s_]+/g, "-");
  return s || "section";
}

function headingText(h: Heading): string {
  const walk = (nodes: PhrasingContent[]): string =>
    nodes
      .map((n) => ("value" in n ? String(n.value) : "children" in n ? walk(n.children as PhrasingContent[]) : ""))
      .join("");
  return walk(h.children).trim();
}

export function parseMdSections(text: string): MdDoc {
  const root = unified().use(remarkParse).parse(text) as Root;
  const tree: MdSection[] = [];
  const stack: MdSection[] = []; // open sections, shallow -> deep
  const byId = new Map<string, MdSection>();
  const seen = new Map<string, number>();
  let firstHeadingStart = -1;

  for (const child of root.children) {
    if (child.type !== "heading") continue;
    const start = child.position?.start.offset;
    const ownStart = child.position?.end.offset;
    if (start == null || ownStart == null) continue;
    if (firstHeadingStart < 0) firstHeadingStart = start;
    const title = headingText(child);
    const base = slugify(title);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const sec: MdSection = {
      id: n ? `${base}-${n}` : base,
      depth: child.depth,
      title,
      start,
      ownStart,
      ownEnd: 0, // finalized below
      end: text.length,
      children: [],
    };
    // Close every open section at this depth or deeper: its span ends here.
    while (stack.length && stack[stack.length - 1].depth >= sec.depth) {
      stack.pop()!.end = start;
    }
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(sec);
    else tree.push(sec);
    stack.push(sec);
    byId.set(sec.id, sec);
  }

  // A section's own body ends where its first subsection's heading begins.
  const finalize = (secs: MdSection[]) => {
    for (const s of secs) {
      s.ownEnd = s.children.length ? s.children[0].start : s.end;
      finalize(s.children);
    }
  };
  finalize(tree);

  const pre =
    firstHeadingStart > 0 ? text.slice(0, firstHeadingStart) : firstHeadingStart < 0 ? text : "";
  return { tree, preamble: pre.trim() ? pre : "", byId, folds: computeListFolds(root) };
}

// A section's own body (its subsections render separately, nested below it).
export function sliceOwn(text: string, sec: MdSection): string {
  return text.slice(sec.ownStart, sec.ownEnd);
}

export function allSectionIds(doc: MdDoc): Set<string> {
  return new Set(doc.byId.keys());
}

// The id chain from a top-level section down to `id` (inclusive) — what must
// be expanded for that section (or a #anchor naming it) to become visible.
export function expandChain(doc: MdDoc, id: string): string[] {
  const chain: string[] = [];
  const walk = (secs: MdSection[], trail: string[]): boolean => {
    for (const s of secs) {
      if (s.id === id) {
        chain.push(...trail, s.id);
        return true;
      }
      if (walk(s.children, [...trail, s.id])) return true;
    }
    return false;
  };
  walk(doc.tree, []);
  return chain;
}

function normPath(p: string): string {
  const abs = p.startsWith("/");
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return (abs ? "/" : "") + parts.join("/");
}

export const MD_LINK_RE = /\.(md|markdown|mdx)$/i;

// Classify a link href clicked inside the viewer. Returns a resolved markdown
// target to open in the viewer, or null when the caller should fall back to
// other handling (external http, in-page #anchor, non-md file).
export function resolveMdLink(
  currentPath: string,
  href: string,
): { path: string; frag?: string } | null {
  const m = href.match(/^([^#]*?)(?:#(.*))?$/);
  const raw = m?.[1] ?? "";
  const frag = m?.[2] || undefined;
  if (!raw || !MD_LINK_RE.test(raw)) return null;
  if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(raw)) return null; // remote .md: external
  let path = raw;
  if (!raw.startsWith("/") && !raw.startsWith("~")) {
    const dir = currentPath.replace(/\/[^/]*$/, "");
    path = `${dir}/${raw}`;
  }
  return { path: normPath(path), frag };
}
