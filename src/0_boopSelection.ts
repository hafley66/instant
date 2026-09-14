// Boop selection model: the tmux-navigation secondary dropdown's data contract.
// `boop beep selection list` returns the registered Boop harness routes that
// have a live tmux pane, already sorted newest-focus-first. The UI renders that
// list, persists each row's checked state, and bulk-sends to the displayed
// selection. Pure parsing + command construction live here so they can be
// tested without a backend; the RPC wrappers reuse clickRpc.runClick, so no
// generated Tauri contract or new endpoint is needed.
//
// Import direction: terminal.ts imports the focus recorder here (model only,
// no React); the rail component (1_boopSelection.tsx) imports this plus openTab.
// This module never imports the component or terminal, so there is no cycle.
import { clickRpc } from "./ipc/contract";
import { shQuote } from "./core";

// One row of `boop beep selection list`. `pane` is the leaf tmux pane target
// (`%N`) when the backend resolved one; `session` is the attach name; `target`
// is the composed `session:window.pane`; `kind` is the registry route kind
// (coordinator/native on a current backend; empty when an older boop omitted
// it). Only coordinators and interactive natives are recipients.
export interface BoopSelectionRow {
  route: string;
  kind: string;
  session: string;
  pane: string;
  target: string;
  title: string;
  lastFocusedAt: number | null;
  selected: boolean;
}

// run_click resolves an empty cwd to HOME; boop reads its own store from there.
const CLICK_CWD = "";

// ---- pure parsing ----

// Strict decode: a malformed body or an invalid row is an error the panel
// surfaces, never a silent empty list (which would read as "no live sessions").
// Undefined optional fields take documented defaults; a present field of the
// wrong type is rejected.
export function parseSelectionList(stdout: string): BoopSelectionRow[] {
  const raw = parseJson(stdout);
  if (!Array.isArray(raw)) {
    throw new Error("boop beep selection list: expected a JSON array");
  }
  return raw.map((item, index) => decodeSelectionRow(item, index));
}

function parseJson(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) throw new Error("boop beep selection list: empty output");
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(
      `boop beep selection list: invalid JSON (${e instanceof Error ? e.message : String(e)})`,
    );
  }
}

function decodeSelectionRow(item: unknown, index: number): BoopSelectionRow {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error(`boop beep selection list: row ${index} is not an object`);
  }
  const r = item as Record<string, unknown>;
  const route = stringField(r.route, `row ${index} route`, true).trim();
  if (!route) throw new Error(`boop beep selection list: row ${index} has no route`);
  return {
    route,
    kind: stringField(r.kind, `row ${index} kind`, false),
    session: stringField(r.session, `row ${index} session`, false) || route,
    pane: stringField(r.pane, `row ${index} pane`, false),
    target: stringField(r.target, `row ${index} target`, false),
    title: stringField(r.title, `row ${index} title`, false),
    lastFocusedAt: focusField(r.lastFocusedAt, index),
    selected: boolField(r.selected, `row ${index} selected`),
  };
}

function stringField(value: unknown, label: string, required: boolean): string {
  if (value === undefined || value === null) {
    if (required) throw new Error(`boop beep selection list: ${label} is required`);
    return "";
  }
  if (typeof value !== "string") {
    throw new Error(`boop beep selection list: ${label} must be a string`);
  }
  return value;
}

function boolField(value: unknown, label: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") {
    throw new Error(`boop beep selection list: ${label} must be a boolean`);
  }
  return value;
}

function focusField(value: unknown, index: number): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`boop beep selection list: row ${index} lastFocusedAt must be a finite number`);
  }
  return value;
}

// ---- pure command construction ----

// Every argument is single-quoted via shQuote (never pathArg's whitespace-only
// shortening) so an arbitrary route/title/body cannot inject shell.
export function selectionListCommand(): string {
  return "boop beep selection list";
}

export function selectionSetCommand(route: string, checked: boolean): string {
  return `boop beep selection set ${shQuote(route)}${checked ? " --checked" : ""}`;
}

export function selectionFocusCommand(target: string, at: number): string {
  return `boop beep selection focus ${shQuote(target)} --at ${Math.floor(at)}`;
}

export function selectionClearCommand(): string {
  return "boop beep selection clear";
}

// Explicit recipient snapshot: one --to per route. Throws on an empty route
// list so an accidental broad shout can never be constructed. `--` separates
// options from the positional body, so a body starting with `-` is literal text
// rather than a parsed flag, and every argument is single-quoted via shQuote.
export function selectionShoutCommand(routes: readonly string[], body: string): string {
  if (!routes.length) throw new Error("boop beep shout: no recipients");
  const to = routes.map((route) => `--to ${shQuote(route)}`).join(" ");
  return `boop beep shout ${to} --as ${shQuote("instant")} -- ${shQuote(body)}`;
}

// ---- pure formatting ----

// Compact age for the "recent focus" column; null/0 (never focused) reads "—".
export function formatRecentFocus(lastFocusedAt: number | null, now: number): string {
  if (lastFocusedAt === null || lastFocusedAt <= 0) return "—";
  const seconds = Math.max(0, Math.round((now - lastFocusedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

// ---- open-tab eligibility ----

// Only a coordinator or an interactive native is a recipient. A `lane` is a
// supervised child, a `shell` is a raw pane, and an empty or unrecognized kind
// is untrusted (an older binary that did not stamp it), so none of them are
// recipients. This reads the kind field, never a route-name prefix.
const RECIPIENT_KINDS = new Set(["coordinator", "native"]);

export function rowIsRecipient(row: Pick<BoopSelectionRow, "kind">): boolean {
  return RECIPIENT_KINDS.has(row.kind);
}

// Does one open terminal tab reach the row's live pane? A tab with an explicit
// tmux target must name the exact pane (`%N`), the exact composed target
// (`session:window.pane`), or the session; an ambiguous window-only
// (`session:window`) or mismatched target matches nothing. A plain tab is
// known by the tmux session name. A display alias is never consulted, so a
// renamed tab cannot pull in a different route's pane.
export function tabReachesRow(tab: FocusTargetTab, row: BoopSelectionRow): boolean {
  const target = tab.tmuxTarget?.trim();
  if (!target) return tab.name === row.session;
  return target === row.pane || target === row.target || target === row.session;
}

// The rows a person can see and send to: a recipient route with a resolved pane
// that a currently-open terminal tab reaches. Graphics (kitty/awrit) and
// browser tabs are not terminals, so they never make a route eligible. Order is
// the backend's most-recently-focused order, preserved.
export function eligibleRows(
  rows: readonly BoopSelectionRow[],
  tabs: readonly FocusTargetTab[],
): BoopSelectionRow[] {
  return rows.filter(
    (row) =>
      row.pane.length > 0 &&
      rowIsRecipient(row) &&
      tabs.some((tab) => !tab.graphics && !tab.browser && tabReachesRow(tab, row)),
  );
}

// ---- focus target + dedup ----

export interface FocusTargetTab {
  name: string;
  tmuxTarget?: string;
  graphics?: boolean;
  browser?: boolean;
}

// Prefer the leaf pane target (`%N`) when the tab carries one (viewer tabs);
// plain tabs attach the session by name, which is also the backend's fallback.
export function boopFocusTarget(tab: FocusTargetTab): string {
  const target = tab.tmuxTarget?.trim();
  return target ? target : tab.name;
}

// A window, not equality: Date.now() advances between the paired focus events
// (mousedown + textarea focus, dock activation + focus) that describe one reach.
export const FOCUS_DEDUP_MS = 2000;

export function isRedundantFocus(
  prevTarget: string | null,
  prevAt: number,
  target: string,
  at: number,
  windowMs: number = FOCUS_DEDUP_MS,
): boolean {
  return prevTarget === target && at - prevAt < windowMs;
}

// ---- local refresh event ----

// Focus persists asynchronously; the panel listens for this rather than polling
// on a tighter interval, so a new reach shows up immediately while typing in the
// rail is never disturbed (the rail itself is not rebuilt).
export const SELECTION_REFRESH_EVENT = "instant:boop-selection-refresh";

export function dispatchSelectionRefresh(): void {
  window.dispatchEvent(new Event(SELECTION_REFRESH_EVENT));
}

export function onSelectionRefresh(listener: () => void): () => void {
  window.addEventListener(SELECTION_REFRESH_EVENT, listener);
  return () => window.removeEventListener(SELECTION_REFRESH_EVENT, listener);
}

// ---- RPC wrappers (real IO; not unit-tested) ----

function run(command: string): Promise<string> {
  return clickRpc.runClick({ command, cwd: CLICK_CWD });
}

export async function listSelection(): Promise<BoopSelectionRow[]> {
  return parseSelectionList(await run(selectionListCommand()));
}

export async function setSelection(route: string, checked: boolean): Promise<void> {
  await run(selectionSetCommand(route, checked));
}

export async function clearSelection(): Promise<void> {
  await run(selectionClearCommand());
}

export async function focusSelection(target: string, at: number): Promise<void> {
  await run(selectionFocusCommand(target, at));
}

export async function shoutSelection(routes: readonly string[], body: string): Promise<string> {
  return run(selectionShoutCommand(routes, body));
}

// ---- focus recorder ----

let lastFocusTarget: string | null = null;
let lastFocusAt = 0;

// Record one genuine reach at a terminal. `suppressed` covers boot restore
// (replaying) and backgrounded documents; output-driven events are never wired
// here, so output never bumps recency. Duplicate same-target reaches inside the
// dedup window are dropped. Persist, then nudge the open panel to refresh.
export function recordBoopFocus(target: string, at: number, suppressed = false): void {
  if (suppressed || !target) return;
  if (isRedundantFocus(lastFocusTarget, lastFocusAt, target, at)) return;
  lastFocusTarget = target;
  lastFocusAt = at;
  void focusSelection(target, at).then(dispatchSelectionRefresh).catch(() => {});
}