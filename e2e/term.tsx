// E2E bootstrap for the terminal + session sidebar. Mirrors e2e/paint.tsx:
// registers a minimal sessions panel, wires the dock hooks the terminal needs,
// mounts the dock, and opens a terminal whose right sidebar shows a file
// explorer. The native (Tauri) edge is mocked via __instantE2eNativeResults
// (see src/reactive/nativeTransport.ts), so this runs in headless Chrome with
// no Rust backend.
import "xp.css";
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
(window as E2eWindow).__instantE2eNativeResults = {
  cass_status: { available: true, path: "/opt/homebrew/bin/cass" },
  list_dir: {
    path: "/tmp/term-e2e",
    parent: "/tmp",
    entries: [
      { name: "src", path: "/tmp/term-e2e/src", is_dir: true, size: 0, modified: 0, ext: "" },
      { name: "e2e", path: "/tmp/term-e2e/e2e", is_dir: true, size: 0, modified: 0, ext: "" },
      { name: "README.md", path: "/tmp/term-e2e/README.md", is_dir: false, size: 64, modified: 0, ext: "md" },
      { name: "package.json", path: "/tmp/term-e2e/package.json", is_dir: false, size: 32, modified: 0, ext: "json" },
    ],
  },
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

document.querySelector<HTMLButtonElement>("[data-testid=open-term]")!.onclick = () => {
  openTab("e2e", { cwd: "/tmp/term-e2e" });
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
