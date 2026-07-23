// Pure session-sidebar derivations. Harness adapters expose AiMessage records;
// React owns I/O and navigation, while this module turns those records into the
// stable rows consumed by TreeTable.
import type { AiMessage, FsEntry } from "./state";

export type FileAction = "read" | "write" | "edit" | "unknown";

export interface FileReference {
  path: string;
  action: FileAction;
  turn: AiMessage;
}

export interface TouchedFile {
  entry: FsEntry;
  references: FileReference[];
  firstTouchedAt: number;
  lastTouchedAt: number;
  lastReadAt: number;
  touchCount: number;
  displayPath: string;
}

const FILE_PATH_RE = /(?:\[([^\]]+)\]\s*)?\{[^\n{}]*"file_path"\s*:\s*"([^"]+)"[^\n{}]*\}/g;

export function resolveFile(raw: string, cwd: string): string {
  if (raw.startsWith("~") || raw.startsWith("/")) return raw;
  return (cwd.replace(/\/$/, "") + "/" + raw).replace(/\/+/g, "/");
}

export function fileEntry(path: string): FsEntry {
  const name = path.split("/").pop() || path;
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  return { name, path, is_dir: false, size: 0, modified: 0, ext };
}

function actionOf(tool: string | undefined): FileAction {
  const lower = (tool ?? "").toLowerCase();
  if (lower.includes("read")) return "read";
  if (lower.includes("write")) return "write";
  if (lower.includes("edit")) return "edit";
  return "unknown";
}

export function turnReferences(turn: AiMessage, cwd: string): FileReference[] {
  const seen = new Set<string>();
  const refs: FileReference[] = [];
  for (const match of turn.text.matchAll(FILE_PATH_RE)) {
    const path = resolveFile(match[2], cwd);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    refs.push({ path, action: actionOf(match[1]), turn });
  }
  return refs;
}

function shortPath(path: string, all: string[]): string {
  const parts = path.split("/").filter(Boolean);
  for (let width = 1; width <= parts.length; width++) {
    const candidate = parts.slice(-width).join("/");
    if (all.filter((p) => p.endsWith(candidate)).length === 1) return candidate;
  }
  return path;
}

export function touchedFiles(turns: AiMessage[], cwdFor: (turn: AiMessage) => string): TouchedFile[] {
  const byPath = new Map<string, FileReference[]>();
  for (const turn of turns) {
    for (const ref of turnReferences(turn, cwdFor(turn))) {
      const refs = byPath.get(ref.path);
      if (refs) refs.push(ref);
      else byPath.set(ref.path, [ref]);
    }
  }
  const paths = [...byPath.keys()];
  return paths.map((path) => {
    const references = byPath.get(path)!;
    const times = references.map((ref) => ref.turn.ts || ref.turn.seq);
    const reads = references.filter((ref) => ref.action === "read").map((ref) => ref.turn.ts || ref.turn.seq);
    return {
      entry: fileEntry(path),
      references,
      firstTouchedAt: Math.min(...times),
      lastTouchedAt: Math.max(...times),
      lastReadAt: reads.length ? Math.max(...reads) : 0,
      touchCount: references.length,
      displayPath: shortPath(path, paths),
    };
  });
}

export function isMarkdown(entry: FsEntry): boolean {
  return entry.ext.toLowerCase() === "md" || entry.ext.toLowerCase() === "mdx";
}

export function isCompaction(turn: AiMessage): boolean {
  return /(?:<command-name>\/compact<\/command-name>|\/(?:compact|save-session)|compaction)/i.test(
    `${turn.preview}\n${turn.text}`,
  );
}

export function isToolOnlyTurn(turn: AiMessage): boolean {
  return Boolean(turn.subtype) || /^\s*\[[^\]]+\]\s*(?:\{|\[|$)/.test(turn.text);
}

const SPECIAL_SUBTYPE = /^\s*\[([^\]\r\n]+)\]\s*/;

// Tool/thinking records preserve their author (`role`) on the wire. The
// bracketed producer name is presentation metadata, so keep it out of the
// clipped primary text and render it beside the role instead.
export function turnSubtype(turn: AiMessage): string | null {
  return turn.subtype
    ?? SPECIAL_SUBTYPE.exec(turn.preview)?.[1]?.trim()
    ?? SPECIAL_SUBTYPE.exec(turn.text)?.[1]?.trim()
    ?? null;
}

export function turnPrimaryPreview(turn: AiMessage): string {
  const source = SPECIAL_SUBTYPE.test(turn.preview)
    ? turn.preview
    : SPECIAL_SUBTYPE.test(turn.text)
      ? turn.text
      : (turn.preview || turn.text);
  return source.replace(SPECIAL_SUBTYPE, "").trim() || source;
}

export function turnRoleLabel(turn: AiMessage): string {
  const subtype = turnSubtype(turn);
  return subtype ? `${turn.role} · ${subtype}` : turn.role;
}

export interface TurnWindow {
  turn: AiMessage;
  tools: AiMessage[];
}

// The transcript is read oldest-first to assign every tool-only record to its
// immediately preceding visible record, then presented newest-first. Tool
// records before any visible record have no owner and remain out of the
// visible-text projection.
export function visibleTurnWindows(turns: AiMessage[]): TurnWindow[] {
  const chronological = [...turns].sort((a, b) => a.seq - b.seq);
  const windows: TurnWindow[] = [];
  let current: TurnWindow | undefined;
  let codexPending: AiMessage[] = [];
  for (const turn of chronological) {
    if (isToolOnlyTurn(turn)) {
      if (turn.editor === "codex" || turn.editor === "kimi") codexPending.push(turn);
      else current?.tools.push(turn);
      continue;
    }
    current = {
      turn,
      tools: (turn.editor === "codex" || turn.editor === "kimi") && turn.role === "assistant" ? codexPending.splice(0) : [],
    };
    windows.push(current);
  }
  if (codexPending.length) current?.tools.push(...codexPending);
  return windows.sort((a, b) => turnOrder(b.turn) - turnOrder(a.turn));
}

export function turnOrder(turn: AiMessage): number {
  return turn.ts >= 10_000_000_000 ? turn.ts : turn.seq;
}
