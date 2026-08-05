/**
 * @license
 * Gerrit DiffInfo/DiffContent/DiffFileMetaInfo/ChangeType contracts below are
 * derived from PolyGerrit `polygerrit-ui/app/api/diff.ts` (Copyright 2020 Google
 * LLC, SPDX-License-Identifier Apache-2.0). Verbatim shape highlights are kept
 * under a mapping comment so a downstream consumer can rebind these types to
 * the upstream declaration instead of this local copy.
 *
 * The translation logic (git -> Gerrit shapes) is original work.
 * SPDX-License-Identifier: Apache-2.0
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ChangeType = "ADDED" | "MODIFIED" | "DELETED" | "RENAMED" | "COPIED" | "REWRITE";

export interface DiffFileMetaInfo {
  name: string;
  content_type: string;
  lines: number;
  language?: string;
}

export interface DiffContent {
  a?: string[];
  b?: string[];
  ab?: string[];
}

export interface DiffInfo {
  meta_a?: DiffFileMetaInfo;
  meta_b?: DiffFileMetaInfo;
  change_type: ChangeType;
  intraline_status: "OK" | "Error" | "Timeout";
  content: DiffContent[];
  binary?: boolean;
  diff_header?: string[];
}

export interface DiffedFile {
  path: string;
  type: ChangeType;
  info: DiffInfo;
}

export function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  if (normalized === "") return [];
  const lines = normalized.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

type Op =
  | { kind: "same"; line: string }
  | { kind: "del"; line: string }
  | { kind: "ins"; line: string };

/**
 * LCS-based edit script. O(N*M) in the worst case; fine for the small ledger
 * fixtures this lab targets and deterministic for a given pair of inputs.
 */
export function myersDiff(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "same", line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: "del", line: a[i] });
      i++;
    } else {
      ops.push({ kind: "ins", line: b[j] });
      j++;
    }
  }
  while (i < n) {
    ops.push({ kind: "del", line: a[i] });
    i++;
  }
  while (j < m) {
    ops.push({ kind: "ins", line: b[j] });
    j++;
  }
  return ops;
}

/**
 * Flattens an edit script into Gerrit DiffContent segments: every run of
 * unchanged lines becomes an `ab` group; every run of deletions and/or
 * insertions becomes an `a`/`b` group.
 */
export function contentGroups(ops: Op[]): DiffContent[] {
  const groups: DiffContent[] = [];
  let ab: string[] = [];
  let a: string[] = [];
  let b: string[] = [];

  const flush = () => {
    if (ab.length || a.length || b.length) {
      const group: DiffContent = {};
      if (ab.length) group.ab = ab;
      if (a.length) group.a = a;
      if (b.length) group.b = b;
      groups.push(group);
      ab = [];
      a = [];
      b = [];
    }
  };

  for (const op of ops) {
    if (op.kind === "same") {
      if (a.length || b.length) flush();
      ab.push(op.line);
    } else if (op.kind === "del") {
      if (ab.length) flush();
      a.push(op.line);
    } else {
      if (ab.length) flush();
      b.push(op.line);
    }
  }
  flush();
  return groups;
}

function contentType(path: string): string {
  const mapped: Record<string, string> = {
    ts: "text/x-typescript",
    tsx: "text/x-typescript",
    js: "text/javascript",
    jsx: "text/javascript",
    md: "text/markdown",
    text: "text/plain",
    txt: "text/plain",
    json: "application/json",
    sh: "text/x-shellscript",
    py: "text/x-python",
    rs: "text/x-rust",
    css: "text/css",
    html: "text/html",
  };
  const ext = path.split(".").pop() ?? "";
  return mapped[ext] ?? "text/plain";
}

function isBinary(text: string): boolean {
  return text.includes("\0");
}

function metaOf(path: string, text: string | undefined, lines: number): DiffFileMetaInfo | undefined {
  if (text === undefined) return undefined;
  return {
    name: path,
    content_type: isBinary(text) ? "application/octet-stream" : contentType(path),
    lines,
  };
}

export interface BuildDiffInput {
  path: string;
  changeType: ChangeType;
  aText?: string;
  bText?: string;
}

/**
 * Pure core: given two file bodies (or one, for ADDED/DELETED) return the
 * Gerrit DiffInfo entity. Deterministic: same inputs, same output.
 */
export function buildDiffInfo(input: BuildDiffInput): DiffInfo {
  const aLines = input.aText === undefined ? undefined : splitLines(input.aText);
  const bLines = input.bText === undefined ? undefined : splitLines(input.bText);
  const aTextEmpty = input.aText === undefined;
  const bTextEmpty = input.bText === undefined;
  const binary = (input.aText ?? "") + (input.bText ?? "");

  let content: DiffContent[];
  if (aTextEmpty || bTextEmpty) {
    content = bLines ? [{ b: bLines }] : [{ a: aLines }];
  } else {
    content = contentGroups(myersDiff(aLines!, bLines!));
  }

  const info: DiffInfo = {
    meta_a: metaOf(input.path, input.aText, aLines?.length ?? 0),
    meta_b: metaOf(input.path, input.bText, bLines?.length ?? 0),
    change_type: input.changeType,
    intraline_status: "OK",
    content,
  };
  if (isBinary(binary)) info.binary = true;
  return info;
}

export interface NameStatusEntry {
  path: string;
  type: ChangeType;
  fromPath?: string;
}

function changeTypeFromCode(code: string): ChangeType {
  switch (code) {
    case "A":
      return "ADDED";
    case "M":
      return "MODIFIED";
    case "D":
      return "DELETED";
    case "R":
      return "RENAMED";
    case "C":
      return "COPIED";
    case "T":
      return "REWRITE";
    default:
      return "MODIFIED";
  }
}

/**
 * Parses `git diff --name-status` output (raw or -z) into {path, type}.
 */
export function parseNameStatus(output: string): NameStatusEntry[] {
  const tokens = output.split("\0");
  const lines = tokens.length > 1 ? tokens.filter((t) => t !== "") : output.split("\n").filter((l) => l !== "");
  const entries: NameStatusEntry[] = [];
  // Raw (non-pathsep) mode: each line is "XY\tpath" or "R100\told\tnew".
  if (lines.every((l) => /\t/.test(l))) {
    for (const line of lines) {
      const [codeAndScore, ...rest] = line.split("\t");
      const code = codeAndScore[0];
      if (rest.length === 2) {
        entries.push({ path: rest[1], type: changeTypeFromCode(code), fromPath: rest[0] });
      } else {
        entries.push({ path: rest[0], type: changeTypeFromCode(code) });
      }
    }
    return entries;
  }
  // -z mode: "XY\npath" repeated.
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i][0];
    const path = lines[i + 1];
    entries.push({ path, type: changeTypeFromCode(code) });
  }
  return entries;
}

export interface TranslationRepo {
  repo: string;
  from: string;
  to: string;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * Builds a throwaway repo with two patch sets (like the ledger lab): a base
 * commit and a change commit that modifies one file and adds another.
 * Returns the repo path plus the two commit SHAs used as parent..revision.
 */
export function makeTranslationRepo(): TranslationRepo {
  const repo = mkdtempSync(join(tmpdir(), "gerrit-translation-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Translation Lab");
  git(repo, "config", "user.email", "lab@example.invalid");

  writeFileSync(join(repo, "base.txt"), "one\ntwo\nthree\n");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-q", "-m", "base");
  const from = git(repo, "rev-parse", "HEAD");

  writeFileSync(join(repo, "base.txt"), "one\nTWO\nthree\nfour\n");
  writeFileSync(join(repo, "added.txt"), "new file\nline two\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "change A");
  const to = git(repo, "rev-parse", "HEAD");

  return { repo, from, to };
}

export function gitFileText(repo: string, commit: string, path: string): string | undefined {
  try {
    return execFileSync("git", ["show", `${commit}:${path}`], { cwd: repo, encoding: "utf8" });
  } catch {
    return undefined;
  }
}

/**
 * Real-git seam: name-status between two commits, then a DiffInfo per file.
 * This is the smallest code path a runtime must implement to feed PolyGerrit's
 * DiffInfo contract from the Git-only ledger.
 */
export function gitToGerritDiff(repo: string, from: string, to: string): DiffedFile[] {
  const status = git(repo, "diff", "--name-status", from, to);
  const entries = parseNameStatus(status);
  return entries.map((entry) => {
    const aText = entry.type === "ADDED" ? undefined : gitFileText(repo, from, entry.path);
    const bText = entry.type === "DELETED" ? undefined : gitFileText(repo, to, entry.path);
    return {
      path: entry.path,
      type: entry.type,
      info: buildDiffInfo({ path: entry.path, changeType: entry.type, aText, bText }),
    };
  });
}
