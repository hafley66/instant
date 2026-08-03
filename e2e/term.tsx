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
} from "../src/terminal";
import { setHomeDir, sessionId } from "../src/core";
import { store } from "../src/state";
import { installKeymap } from "../src/keymap";
import { wireContextMenu } from "../src/ctxmenu";

// Mock list_dir with a small fixture tree so the sidebar's file explorer has
// rows to render. Other commands (open_session/resize_pty/write_pty) resolve
// undefined, which the app tolerates in e2e (all invokes are .catch'd).
type E2eWindow = Window & { __instantE2eNativeResults?: Record<string, unknown> };
const NOW = Date.now();
const E2E_HARNESS = new URLSearchParams(window.location.search).get("harness") === "kimi" ? "kimi" : "codex";
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
  [`${ROOT}/e2e`]: [`${ROOT}/e2e/MdPanel.tsx`],
};
const DIR_SET = new Set([`${ROOT}/src`, `${ROOT}/e2e`, `${ROOT}/src/mdview`]);

(window as E2eWindow).__instantE2eNativeResults = {
  cass_status: { available: true, path: "/opt/homebrew/bin/cass" },
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
  // The repo root a cwd belongs to, and the gitignore-aware file list under it.
  // Two MdPanel.tsx copies make a bare filename ambiguous on purpose, which is
  // what puts the resolver into its picker branch.
  worktree_at: { worktree: ROOT, branch: "main", head: "e2e", is_main: true },
  search_files: [
    entry(`${ROOT}/src/main.ts`),
    entry(`${ROOT}/src/preview.ts`),
    entry(`${ROOT}/src/mdview/MdPanel.tsx`),
    entry(`${ROOT}/e2e/MdPanel.tsx`),
  ],
  // harness_session resolves a session id for a (tool, cwd) probe. The Turns
  // pane resolver probes every editor; return one only for Codex so a single
  // transcript node renders. A function
  // fixture uses the args-aware path in nativeTransport's e2e branch.
  harness_session: (args: Record<string, unknown> | undefined) =>
    args?.tool === E2E_HARNESS ? `e2e-${E2E_HARNESS}-1` : undefined,
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
      text: "I'll move the terminal chrome to .dv-host-term so FitAddon measures a zero-chrome host.",
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
  ],
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
  {
    id: "term.sidebar",
    keys: ["$mod+Shift+Backslash"],
    run: () => {
      const id = getFocusedTermId();
      if (!id) return;
      const cur = store.get().termSidebar[id] ?? { open: false, width: 264 };
      store.set({ termSidebar: { ...store.get().termSidebar, [id]: { ...cur, open: !cur.open } } });
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
};
(window as Window & { __term?: TermHooks }).__term = {
  write: (data) => writeTerm(sessionId("e2e"), data),
  point: (row, col) => termCellPoint(sessionId("e2e"), row, col),
  resize: (cols, rows) => resizeTerm(sessionId("e2e"), cols, rows),
  dims: () => termDims(sessionId("e2e")),
};

document.querySelector<HTMLButtonElement>("[data-testid=open-term]")!.onclick = () => {
  openTab("e2e", { cwd: ROOT });
  // Reveal the sidebar immediately on open (the ⌘⇧\ hotkey toggles it too).
  // Seed the pane split. Touched is derived from the session transcript; Turns
  // is the initial source.
  const sid = sessionId("e2e");
  store.set({
    termSidebar: {
      ...store.get().termSidebar,
      [sid]: { open: true, width: 460, source: "turns", sizes: [55, 45] },
    },
  });
};

mountReactDock(document.getElementById("dock")!);
initRail();
wireContextMenu(() => []);
