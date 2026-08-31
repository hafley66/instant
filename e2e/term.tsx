// E2E bootstrap for the terminal + session sidebar. Mirrors e2e/paint.tsx:
// registers a minimal sessions panel, wires the dock hooks the terminal needs,
// mounts the dock, and opens a terminal whose right sidebar shows a file
// explorer. The native (Tauri) edge is mocked via __instantE2eNativeResults
// (see src/reactive/nativeTransport.ts), so this runs in headless Chrome with
// no Rust backend.
import "xp.css";
// xterm's own stylesheet positions .xterm-screen over .xterm-viewport. Without
// it the screen element flows below the host and every cell-to-pixel mapping
// (hover, ⌘-click hit testing) points offscreen.
import "@xterm/xterm/css/xterm.css";
import "../src/styles.css";
import { createElement } from "react";
import type { IDockviewPanelProps } from "dockview";
import { registerPlugin } from "../src/plugin";
import { initRail } from "../src/rail";
import { mountReactDock, setDockHooks } from "../src/reactdock";
import {
  openTab,
  onTermShown,
  onTermClosed,
  fitTerm,
  tabMetaById,
  getFocusedTermId,
  writeTerm,
  resizeTerm,
  termCellPoint,
  termDims,
  tabs,
  askAboutSelection,
  syncTurnDebugOverlays,
} from "../src/terminal";
import { turnDebug } from "../src/0_turnDebugSettings";
import { setHomeDir, sessionId } from "../src/core";
import { settings } from "../src/0_settings";
import { store } from "../src/state";
import { installKeymap } from "../src/keymap";
import { wireContextMenu } from "../src/ctxmenu";
import { ctxItemsFor, setLastCtxPoint } from "../src/chrome";
import { closeActiveTab, reopenLastTab } from "../src/tabs";
import { openPreviewPanel } from "../src/preview";
import { cmdClickRouter, wireDomCmdClick } from "../src/clickrules";

// Mock list_dir with a small fixture tree so the sidebar's file explorer has
// rows to render. Other commands (open_session/resize_pty/write_pty) resolve
// undefined, which the app tolerates in e2e (all invokes are .catch'd).
type E2eWindow = Window & { __instantE2eNativeResults?: Record<string, unknown> };
const cmdClickEvents: unknown[] = [];
(window as Window & { __cmdClickEvents?: unknown[] }).__cmdClickEvents = cmdClickEvents;
(window as Window & { __viewportChanges?: unknown[] }).__viewportChanges = [];
const cmdClickReadout = document.createElement("pre");
cmdClickReadout.dataset.testid = "cmd-click-event-readout";
Object.assign(cmdClickReadout.style, {
  position: "fixed", right: "12px", bottom: "12px", zIndex: "1001", margin: "0",
  padding: "8px 12px", color: "#b8dfff", background: "#101418", border: "1px solid #62a4d4",
  font: "12px monospace", pointerEvents: "none",
});
const domEvents: string[] = [];
const paintCmdClickEvents = (route = "waiting") => {
  cmdClickReadout.textContent = [
    `PREVIOUS DOM EVENTS SEEN: ${domEvents.join(" -> ") || "none"}`,
    "ACTIVATION EDGE: pointerup",
    `ROUTE: ${route}`,
  ].join("\n");
};
paintCmdClickEvents();
document.body.appendChild(cmdClickReadout);
cmdClickRouter.gestures.subscribe((event) => {
  domEvents.push(event.type);
  paintCmdClickEvents();
});
cmdClickRouter.routed.subscribe((event) => {
  cmdClickEvents.push(event);
  paintCmdClickEvents(event.routeId ?? "unhandled");
});
const NOW = Date.now();
const turnLabel = (index: number) => index < 26
  ? String.fromCharCode(65 + index)
  : `A${String.fromCharCode(65 + index - 26)}`;
const E2E_PARAMS = new URLSearchParams(window.location.search);
const requestedHarness = E2E_PARAMS.get("harness");
const E2E_HARNESS = requestedHarness === "claude" || requestedHarness === "opencode" || requestedHarness === "kimi"
  ? requestedHarness
  : "codex";
const E2E_WHEEL_HARNESS = E2E_PARAMS.get("wheelHarness");
const E2E_NO_HARNESS = E2E_PARAMS.has("noHarness");
const E2E_EDGE_TURNS = E2E_PARAMS.has("edgeTurns");
const E2E_THREE_TURNS = E2E_PARAMS.get("edgeTurns") === "3";
const E2E_STRUCTURED = E2E_PARAMS.has("structured");
const E2E_VIEWER = E2E_PARAMS.has("viewer");
const E2E_NO_SIDEBAR = E2E_PARAMS.has("noSidebar");
const E2E_VIEWER_LANE = E2E_PARAMS.get("lane") ?? "e2e-viewer";
const E2E_VIEWER_PANE = E2E_PARAMS.get("pane") ?? "%1";
const E2E_VIEWER_CONTENT = E2E_PARAMS.get("contentB64")
  ? atob(E2E_PARAMS.get("contentB64")!)
  : "VIEWER FIXTURE\r\n";
const ROOT = "/tmp/term-e2e";
const entry = (path: string, is_dir = false) => ({
  name: path.split("/").pop()!,
  path,
  is_dir,
  size: is_dir ? 0 : 64,
  modified: 0,
  ext: is_dir ? "" : path.split(".").pop()!,
});
// The directories the ⌘-hover resolver probes. Only the root listing feeds the
// sidebar explorer; the rest exist so a repo-relative token (`src/main.ts`
// hovered from a shell sitting in the root) resolves to a real file.
const DIRS: Record<string, string[]> = {
  [ROOT]: [`${ROOT}/src`, `${ROOT}/e2e`, `${ROOT}/README.md`, `${ROOT}/package.json`],
  [`${ROOT}/src`]: [`${ROOT}/src/main.ts`, `${ROOT}/src/preview.ts`, `${ROOT}/src/mdview`],
  [`${ROOT}/src/mdview`]: [`${ROOT}/src/mdview/MdPanel.tsx`],
  [`${ROOT}/e2e`]: [`${ROOT}/e2e/MdPanel.tsx`, `${ROOT}/e2e/fixtures`],
  [`${ROOT}/e2e/fixtures`]: [`${ROOT}/e2e/fixtures/tree.json`],
};
// /tmp is the harness $HOME, so /tmp/notes is an ancestor rung of the cwd: a
// token that misses under the repo is found by crawling up to it.
DIRS["/tmp/notes"] = ["/tmp/notes/plan.md"];
const DIR_SET = new Set([`${ROOT}/src`, `${ROOT}/e2e`, `${ROOT}/src/mdview`, `${ROOT}/e2e/fixtures`, "/tmp/notes"]);
const REPORT = `${ROOT}/.worktrees/terminal-inline-diagrams/playwright-report/index.html`;
DIRS[REPORT.slice(0, REPORT.lastIndexOf("/"))] = [REPORT];

const BOOP_TURNS = E2E_STRUCTURED ? [{
  session: `e2e-${E2E_HARNESS}-1`, harness: E2E_HARNESS, turn: 301,
  ts: NOW, role: "assistant",
  said: [
    "STRUCTURED TURN START",
    "| Item | Visibility |",
    "| --- | --- |",
    "| alpha | visible |",
    "| beta | hidden |",
    "- first visible item",
    "- second visible item",
    "STRUCTURED TURN END",
  ].join("\n"),
}] : E2E_THREE_TURNS ? [
  {
    session: `e2e-${E2E_HARNESS}-1`, harness: E2E_HARNESS, turn: 201,
    ts: NOW - 3000, role: "assistant",
    said: ["TOP THREE HIDDEN", "TOP THREE VISIBLE", ...Array.from({ length: 20 }, (_, index) => `TOP THREE BODY ${index}`)].join("\n"),
  },
  {
    session: `e2e-${E2E_HARNESS}-1`, harness: E2E_HARNESS, turn: 202,
    ts: NOW - 2000, role: "assistant",
    said: ["MIDDLE START", ...Array.from({ length: 8 }, (_, index) => `MIDDLE BODY ${index}`), "MIDDLE END"].join("\n"),
  },
  {
    session: `e2e-${E2E_HARNESS}-1`, harness: E2E_HARNESS, turn: 203,
    ts: NOW - 1000, role: "assistant",
    said: ["BOTTOM THREE START", ...Array.from({ length: 20 }, (_, index) => `BOTTOM THREE BODY ${index}`), "BOTTOM THREE HIDDEN"].join("\n"),
  },
] : E2E_EDGE_TURNS ? [
  {
    session: `e2e-${E2E_HARNESS}-1`, harness: E2E_HARNESS, turn: 101,
    ts: NOW - 2000, role: "assistant",
    said: ["TOP HIDDEN", "TOP VISIBLE", ...Array.from({ length: 30 }, (_, index) => `TOP BODY ${index}`)].join("\n"),
  },
  {
    session: `e2e-${E2E_HARNESS}-1`, harness: E2E_HARNESS, turn: 102,
    ts: NOW - 1000, role: "assistant",
    said: ["BOTTOM START", ...Array.from({ length: 30 }, (_, index) => `BOTTOM BODY ${index}`), "BOTTOM HIDDEN"].join("\n"),
  },
] : [...Array.from({ length: 52 }, (_, index) => ({
  session: `e2e-${E2E_HARNESS}-1`, harness: E2E_HARNESS, turn: index + 1,
  ts: NOW - (52 - index) * 1000, role: "assistant", said: turnLabel(index),
})), {
  session: `e2e-${E2E_HARNESS}-1`, harness: E2E_HARNESS, turn: 53,
  ts: NOW, role: "assistant",
  said: [
    "```d2",
    "PTY -> tmux",
    "tmux -> xterm",
    'xterm -> "D2 renderer"',
    "```",
    "```mermaid",
    "flowchart LR",
    "PTY --> tmux",
    "tmux --> xterm",
    "xterm --> Mermaid",
    "```",
  ].join("\n"),
}];

// Stands in for the Rust resolver (src-tauri/src/refresolve.rs), whose rungs are
// tested there. Overrides name the rung each ⌘-click test wants to exercise.
const RESOLVE_FILES = [
  `${ROOT}/src/main.ts`,
  `${ROOT}/src/preview.ts`,
  `${ROOT}/src/mdview/MdPanel.tsx`,
  `${ROOT}/e2e/MdPanel.tsx`,
  REPORT,
];
const RESOLVE_OVERRIDES: Record<string, unknown> = {
  "notes/plan.md": { kind: "hit", ref: { path: "/tmp/notes/plan.md", source: "ancestor" } },
  "src/prevew.ts": { kind: "choices", paths: [`${ROOT}/src/preview.ts`], via: "fuzzy" },
  mdview: { kind: "hit", ref: { path: `${ROOT}/src/mdview`, source: "fuzzy" } },
  "plans/bench/STUDY.md": {
    kind: "absent",
    repo: "/tmp/sprefa",
    rev: "aa95c0ef361e305f362005b09d0fbabaa75afca7",
    path: "plans/bench/STUDY.md",
    subject: "aa95c0ef3 bench: study doc",
  },
};

function resolveRefFixture(token: string, cwd: string) {
  const match = token.match(/^(.*):(\d+)$/);
  const rel = match ? match[1] : token;
  const line = match ? Number(match[2]) : undefined;
  const override = RESOLVE_OVERRIDES[rel];
  if (override) return line ? { ...override, line } : override;
  if (rel.startsWith("/") || rel.startsWith("~/")) {
    return { kind: "hit", ref: { path: rel, line, source: "absolute" } };
  }
  const direct = `${cwd.replace(/\/$/, "")}/${rel}`;
  if (RESOLVE_FILES.includes(direct)) return { kind: "hit", ref: { path: direct, line, source: "cwd" } };
  const named = RESOLVE_FILES.filter((path) => path.endsWith(`/${rel}`));
  if (named.length === 1) return { kind: "hit", ref: { path: named[0], line, source: "search" } };
  if (named.length > 1) return { kind: "choices", paths: named, line, via: "exact" };
  return { kind: "miss" };
}

(window as E2eWindow).__instantE2eNativeResults = {
  boop_mux_capture: "",
  boop_favorites: [],
  boop_favorite_toggle: [],
  boop_turn_comments: [],
  boop_turn_comment_upsert: undefined,
  boop_turn_comment_delete: undefined,
  boop_turn_comments_sent: undefined,
  list_sessions: [],
  open_session: (args: Record<string, unknown> | undefined) => {
    if (args?.attachOnly === true) {
      const id = String(args.id ?? "");
      requestAnimationFrame(() => writeTerm(id, `\x1b[2J\x1b[H${E2E_VIEWER_CONTENT}`));
      (window as Window & { __externalOpenSession?: Record<string, unknown> }).__externalOpenSession = args;
    }
    return undefined;
  },
  close_pty: (args: Record<string, unknown> | undefined) => {
    (window as Window & { __externalClosePty?: Record<string, unknown> }).__externalClosePty = args;
    return undefined;
  },
  list_dir: (args: Record<string, unknown> | undefined) => {
    const path = String(args?.path ?? ROOT);
    const children = DIRS[path];
    if (!children) return { path, parent: ROOT, entries: [] };
    return {
      path,
      parent: path.slice(0, path.lastIndexOf("/")) || "/",
      entries: children.map((c) => entry(c, DIR_SET.has(c))),
    };
  },
  worktree_at: { worktree: ROOT, branch: "main", head: "e2e", is_main: true },
  // The rule rung. Returns rg-shaped stdout so the results panel has rows.
  run_click: (args: Record<string, unknown> | undefined) => {
    (window as Window & { __runClickArgs?: unknown }).__runClickArgs = args;
    // A token nothing matches: rg prints nothing, which used to open no panel.
    if (String(args?.command ?? "").includes("qqqzzz")) return "";
    return `src/preview.ts:12:const preview = 1\n`;
  },
  read_git_blob: (args: Record<string, unknown> | undefined) =>
    `# ${String(args?.path ?? "")}\nwritten at ${String(args?.rev ?? "").slice(0, 7)}\n`,
  resolve_ref: (args: Record<string, unknown> | undefined) =>
    resolveRefFixture(String(args?.token ?? ""), String(args?.cwd ?? ROOT)),
  // harness_session resolves a session id for a (tool, cwd) probe. The Turns
  // pane resolver probes every editor; return one only for Codex so a single
  // transcript node renders. A function
  // fixture uses the args-aware path in nativeTransport's e2e branch.
  harness_session: (args: Record<string, unknown> | undefined) =>
    !E2E_NO_HARNESS && args?.tool === E2E_HARNESS ? `e2e-${E2E_HARNESS}-1` : undefined,
  // Codex writes support records before the visible assistant response. The
  // fixture preserves that sequence so its expanded response proves the rollup.
  read_ai_messages: [
    {
      editor: E2E_HARNESS, session_id: `e2e-${E2E_HARNESS}-1`, id: "m1", seq: 1, role: "user", ts: NOW - 3 * 86_400_000,
      preview: "fix the off-by-one in fitTerm",
      text: "fix the off-by-one in fitTerm so the rows stop drifting",
      locator: "codex:/tmp/term-e2e/e2e-codex-1.jsonl#L1",
    },
    {
      editor: E2E_HARNESS, session_id: `e2e-${E2E_HARNESS}-1`, id: "m2", seq: 2, role: "assistant", subtype: E2E_HARNESS === "kimi" ? "thinking" : "read", ts: NOW - 25 * 3_600_000,
      preview: "README.md and reactdock.tsx",
      text: "[Read] {\"file_path\":\"README.md\"} [Edit] {\"file_path\":\"src/reactdock.tsx\"}",
      locator: "codex:/tmp/term-e2e/e2e-codex-1.jsonl#L2",
    },
    {
      editor: E2E_HARNESS, session_id: `e2e-${E2E_HARNESS}-1`, id: "m3", seq: 3, role: "assistant", ts: NOW - 7 * 3_600_000,
      preview: "moving chrome to .dv-host-term",
      text: [
        "I'll move the terminal chrome to .dv-host-term so FitAddon measures a zero-chrome host.",
        ...Array.from({ length: 28 }, (_, index) => `Implementation detail ${index + 1}: preserve the measured terminal row.`),
      ].join("\n"),
      locator: "codex:/tmp/term-e2e/e2e-codex-1.jsonl#L3",
    },
    {
      editor: E2E_HARNESS, session_id: `e2e-${E2E_HARNESS}-1`, id: "m4", seq: 4, role: "user", ts: NOW - 2 * 3_600_000,
      preview: "/compact lets continue",
      text: "<command-name>/compact</command-name> /compact lets continue",
      locator: "codex:/tmp/term-e2e/e2e-codex-1.jsonl#L4",
    },
    {
      editor: E2E_HARNESS, session_id: `e2e-${E2E_HARNESS}-1`, id: "m5", seq: 5, role: "assistant", subtype: E2E_HARNESS === "kimi" ? "Bash" : "exec", ts: NOW - 15 * 60_000,
      preview: "inspect latest state",
      text: "git status --short",
      locator: "codex:/tmp/term-e2e/e2e-codex-1.jsonl#L5",
    },
    {
      editor: E2E_HARNESS, session_id: `e2e-${E2E_HARNESS}-1`, id: "m6", seq: 6, role: "assistant", ts: NOW - 14 * 60_000,
      preview: "latest visible answer",
      text: "The latest visible answer has a paired tool record before it.",
      locator: "codex:/tmp/term-e2e/e2e-codex-1.jsonl#L6",
    },
    {
      editor: E2E_HARNESS, session_id: `e2e-${E2E_HARNESS}-1`, id: "m7", seq: 7, role: "assistant", ts: NOW - 60_000,
      preview: "terminal diagrams",
      text: [
        "```mermaid",
        "flowchart LR",
        "LEGACY[old diagram] --> UNUSED[not visible in this terminal viewport]",
        "```",
        "",
        "```d2",
        "PTY -> tmux",
        "tmux -> xterm",
        'xterm -> "D2 renderer"',
        "```",
        "",
        "```mermaid",
        "flowchart LR",
        "PTY --> tmux",
        "tmux --> xterm",
        "xterm --> Mermaid",
        "```",
      ].join("\n"),
      locator: "codex:/tmp/term-e2e/e2e-codex-1.jsonl#L7",
    },
  ],
  boop_turns: BOOP_TURNS,
  read_text: "# Terminal\n\n## Sidebar UX\n\nA heading target.\n",
};

function SessionsPanel(_props: IDockviewPanelProps) {
  return createElement("div", { "data-testid": "sessions-panel" }, "Sessions");
}

registerPlugin({
  id: "term-e2e-sessions",
  panels: [
    { id: "sessions", title: "Sessions", icon: "S", iconLabel: "Sessions", component: SessionsPanel },
  ],
});

setHomeDir("/tmp");
setDockHooks({
  onTermActivate: onTermShown,
  onTermClose: onTermClosed,
  onTermLayout: fitTerm,
  onTermRetitle: () => {},
  isTermPinned: () => false,
  toggleTermPin: () => {},
  onTermCwd: (sid) => tabMetaById(sid)?.cwd ?? null,
});

installKeymap([
  { id: "tab.close", keys: ["$mod+w"], run: closeActiveTab },
  { id: "tab.reopen", keys: ["$mod+Shift+t"], run: () => void reopenLastTab() },
  { id: "term.strip", keys: ["$mod+Shift+Period"], run: () => toggleTermStripFor(sessionId("e2e")) },
  {
    id: "term.sidebar",
    keys: ["$mod+Shift+Backslash"],
    run: () => {
      const id = getFocusedTermId();
      if (!id) return;
      const current = settings.termSidebar.$();
      const sidebar = current[id] ?? { open: false, width: 264 };
      settings.termSidebar.$({ ...current, [id]: { ...sidebar, open: !sidebar.open } });
    },
  },
]);

// Terminal test hooks: the headless run has no PTY, so the spec writes fixture
// lines into the emulator itself and asks for the viewport point of a cell.
type TermHooks = {
  write: (data: string) => void;
  point: (row: number, col: number) => { x: number; y: number } | null;
  resize: (cols: number, rows: number) => void;
  dims: () => { cols: number; rows: number } | null;
  position: () => { viewportY: number; baseY: number; length: number; rows: number } | null;
  screen: () => string[];
  scroll: (lines: number) => void;
  selection: () => string;
  mouseMode: () => string;
  pinned: () => string;
  ask: () => void;
  pinnedRects: () => number;
};
(window as Window & { __term?: TermHooks }).__term = {
  write: (data) => writeTerm(sessionId("e2e"), data),
  point: (row, col) => termCellPoint(sessionId("e2e"), row, col),
  resize: (cols, rows) => resizeTerm(sessionId("e2e"), cols, rows),
  dims: () => termDims(sessionId("e2e")),
  position: () => {
    const tab = tabs.get(sessionId("e2e"));
    const buffer = tab?.term.buffer.active;
    return tab && buffer
      ? { viewportY: buffer.viewportY, baseY: buffer.baseY, length: buffer.length, rows: tab.term.rows }
      : null;
  },
  screen: () => {
    const tab = tabs.get(sessionId("e2e"));
    const buffer = tab?.term.buffer.active;
    return tab && buffer
      ? Array.from({ length: tab.term.rows }, (_, row) =>
        buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "")
      : [];
  },
  // A pane whose app owns the mouse never fills xterm's own selection layer, so
  // the pinned overlay is the answer for it (see 0_terminalPinnedSelection.ts).
  selection: () => {
    const tab = tabs.get(sessionId("e2e"));
    return tab?.term.getSelection() || tab?.pinnedSelection?.text() || "";
  },
  mouseMode: () => tabs.get(sessionId("e2e"))?.term.modes.mouseTrackingMode ?? "none",
  pinned: () => tabs.get(sessionId("e2e"))?.pinnedSelection?.text() ?? "",
  ask: () => askAboutSelection(sessionId("e2e")),
  pinnedRects: () => tabs.get(sessionId("e2e"))?.el.querySelectorAll(".term-pinned-selection").length ?? 0,
  scroll: (lines) => {
    const tab = tabs.get(sessionId("e2e"));
    if (tab) tab.term.scrollToLine(Math.max(0, tab.term.buffer.active.viewportY + lines));
    tab?.diagrams?.viewportScrolled();
  },
};

document.querySelector<HTMLButtonElement>("[data-testid=open-term]")!.onclick = () => {
  // Reveal the sidebar immediately on open (the ⌘⇧\ hotkey toggles it too).
  const sid = sessionId("e2e");
  settings.termSidebar.$({
    ...settings.termSidebar.$(),
    [sid]: { open: !E2E_NO_SIDEBAR, width: 460 },
  });
  openTab("e2e", { cwd: ROOT, command: E2E_WHEEL_HARNESS || undefined });
  const events: unknown[] = [];
  (window as Window & { __visibleTurnEvents?: unknown[] }).__visibleTurnEvents = events;
  const readout = document.createElement("pre");
  readout.dataset.testid = "visible-turn-readout";
  Object.assign(readout.style, {
    position: "fixed", right: "12px", top: "8px", zIndex: "1000", margin: "0",
    padding: "8px 12px", color: "#b8ffb8", background: "#101810", border: "1px solid #62d462",
    font: "12px monospace", pointerEvents: "none",
  });
  readout.textContent = "Boop visible turns: scanning";
  document.body.appendChild(readout);
  tabs.get(sid)?.turnVisibility?.changes.subscribe((event) => {
    events.push(event);
    const letter = (turn: { said: string }) => turn.said;
    const visible = new Set(event.visible.map((turn) => turn.id));
    const all = BOOP_TURNS.map((turn) => ({ id: `${turn.session}:${turn.turn}`, said: turn.said }));
    const tab = tabs.get(sid);
    const buffer = tab?.term.buffer.active;
    const xtermRows = tab && buffer
      ? Array.from({ length: tab.term.rows }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "")
      : [];
    if (E2E_EDGE_TURNS) {
      const clippedAbove = E2E_THREE_TURNS ? "TOP THREE HIDDEN" : "TOP HIDDEN";
      const clippedBelow = E2E_THREE_TURNS ? "BOTTOM THREE HIDDEN" : "BOTTOM HIDDEN";
      readout.textContent = [
        `XTERM TOP ROW: ${xtermRows[0] || "blank"}`,
        `XTERM BOTTOM ROW: ${xtermRows.at(-1) || "blank"}`,
        `CLIPPED ABOVE, BOOP ONLY: ${clippedAbove}`,
        `CLIPPED BELOW, BOOP ONLY: ${clippedBelow}`,
        `PROJECTED TURN IDS: ${event.visible.map((turn) => turn.id).join(" ")}`,
      ].join("\n");
      return;
    }
    readout.textContent = [
      `VISIBLE XTERM/TMUX: ${event.visible.map(letter).join(" ") || "none"}`,
      `NOT ON SCREEN, IN BOOP DB: ${all.filter((turn) => !visible.has(turn.id)).map(letter).join(" ") || "none"}`,
      `ENTERED: ${event.entered.map(letter).join(" ") || "none"}`,
      `EXITED: ${event.exited.map(letter).join(" ") || "none"}`,
    ].join("\n");
  });
  tabs.get(sid)?.viewport?.changes.subscribe((event) => {
    (window as Window & { __viewportChanges?: unknown[] }).__viewportChanges?.push(event);
  });
};
document.querySelector<HTMLButtonElement>("[data-testid=open-viewer]")!.onclick = () => {
  openTab(E2E_VIEWER_LANE, { viewer: true, tmuxTarget: E2E_VIEWER_PANE });
};
document.querySelector<HTMLButtonElement>("[data-testid=open-file]")!.onclick = () => {
  openPreviewPanel(`${ROOT}/README.md`);
};
document.querySelector<HTMLButtonElement>("#turn-debug-toggle")!.onclick = (event) => {
  const on = !turnDebug.on.$();
  turnDebug.on.$(on);
  (event.currentTarget as HTMLButtonElement).setAttribute("aria-pressed", String(on));
  syncTurnDebugOverlays();
};

mountReactDock(document.getElementById("dock")!);
initRail();
document.addEventListener("contextmenu", (event) => setLastCtxPoint(event.clientX, event.clientY), true);
wireContextMenu(ctxItemsFor);
wireDomCmdClick();

// A reload is the same persisted-open-tab replay that the desktop composition
// root performs. This fixture keeps the replay explicit so the lifecycle test
// can assert that a pane target and viewer title survive a page reload.
if (E2E_VIEWER && store.get().openTabs.length > 0) {
  for (const tab of store.get().openTabs) {
    openTab(tab.name, { viewer: tab.viewer, tmuxTarget: tab.tmuxTarget });
  }
}
