// Terminal lifecycle: the live-terminal registry (`tabs`), xterm.js + pty wiring,
// the custom key handlers (iTerm-style word/line editing + the kitty keyboard
// protocol for graphics tabs), the OSC-52 clipboard bridge, per-terminal font
// zoom, and the dockview panel lifecycle (activate / show / close / fit) shared
// with browser tabs.
import { Terminal, type ILink } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "./generated/native";
import { store, type OpenTab } from "./state";
import { GraphicsOverlay } from "./graphics";
import { runMatchingCommand } from "./keymap";
import {
  sessionId,
  activeId,
  setActive,
  flashStatus,
  sanitizePaste,
  escapeHtml,
  THEMES,
  termFontFamily,
} from "./core";
import {
  addTermPanel,
  focusTermPanel,
  removeTermPanel,
  hasTermPanel,
} from "./reactdock";
import { dispatchClick, quotedSpanAt, clickIntent, resolveReference } from "./clickrules";
import { nudgeZoom, resetZoom } from "./overlay";
import { inlineSnippetHtml } from "./inlinePreview";
import { openPreviewPanel } from "./preview";
import { browserTabs } from "./browser";
import { warmTurns, tabSessions, unclaimedSession } from "./favorites";
import { tabTitle, reflowPinnedTabs } from "./tabs";
import { detectHarness, trimOutputTail, type HarnessObservation } from "./harness";
import {
  renderSessionActive,
  refreshSessions,
  foregroundProc,
  looksLikeAgentProc,
  KNOWN_RESUME,
} from "./worktrees";

export type Tab = {
  id: string;
  name: string;
  term: Terminal;
  fit: FitAddon;
  el: HTMLElement;
  graphics?: boolean;
  overlay?: GraphicsOverlay;
  harness: HarnessObservation;
  outputTail: string;
};

// Runtime registry of live terminals. These are resources, not serializable app
// state, so they stay out of the store; the active tab *id* lives in the store.
export const tabs = new Map<string, Tab>();

export function observeTerminalOutput(id: string, chunk: string) {
  const tab = tabs.get(id);
  if (!tab) return;
  tab.outputTail = trimOutputTail(tab.outputTail, chunk);
  const meta = tabMetaById(id);
  const live = store.get().sessions.find((s) => s.name === tab.name);
  tab.harness = detectHarness(meta?.command, live?.commands?.[0], tab.outputTail);
  tab.el.dataset.harness = tab.harness.id ?? "unknown";
  tab.el.dataset.harnessConfidence = tab.harness.confidence;
  tab.el.title = tab.harness.id
    ? `${tab.harness.id} · ${tab.harness.confidence} detection`
    : "terminal · harness not detected";
}

export function terminalHarness(id: string): HarnessObservation | null {
  return tabs.get(id)?.harness ?? null;
}

// Device pixels per terminal cell, for the pty's TIOCGWINSZ pixel size. Graphics
// apps (awrit) read ws_xpixel/ws_ypixel to size their framebuffer; without real
// values they render at 0x0. Reads xterm's measured cell box (internal API) and
// scales by devicePixelRatio. Returns camelCase keys; Tauri maps them to the
// command's cell_w/cell_h. Yields {} if unavailable so callers spread harmlessly.
export function cellDims(term: Terminal): { cellW: number; cellH: number } | Record<string, never> {
  const cell = (term as any)?._core?._renderService?.dimensions?.css?.cell;
  if (!cell?.width || !cell?.height) return {};
  const dpr = window.devicePixelRatio || 1;
  return { cellW: Math.round(cell.width * dpr), cellH: Math.round(cell.height * dpr) };
}

// --- kitty keyboard protocol (graphics tabs) -------------------------------
// awrit pushes the full progressive-enhancement flags (CSI > 31 u) on launch and
// then expects every key as a CSI ... u event. xterm.js doesn't speak it, so we
// encode events ourselves for graphics tabs. MVP: text + common named/functional
// keys, modifiers, press/release; standalone modifier keys are skipped.

// Modifier bitfield per spec: 1 + shift(1) + alt(2) + ctrl(4) + super(8).
function kittyMods(e: KeyboardEvent): number {
  return 1 + (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0) + (e.metaKey ? 8 : 0);
}

// CSI encoding for one key event, or null to fall through to xterm.
function kittyKeySeq(e: KeyboardEvent): string | null {
  const CSI = "\x1b[";
  const mods = kittyMods(e);
  const event = e.type === "keyup" ? 3 : e.repeat ? 2 : 1;
  // The modifiers field (with optional :event sub-param), omitted when default.
  const me = mods > 1 || event > 1 ? `;${mods}:${event}` : "";
  const u = (code: number) => `${CSI}${code}${me}u`;
  const tilde = (n: number) => `${CSI}${n}${me}~`;
  const letter = (L: string) => `${CSI}1${me}${L}`;

  switch (e.key) {
    case "Enter": return u(13);
    case "Tab": return u(9);
    case "Backspace": return u(127);
    case "Escape": return u(27);
    case "ArrowUp": return letter("A");
    case "ArrowDown": return letter("B");
    case "ArrowRight": return letter("C");
    case "ArrowLeft": return letter("D");
    case "Home": return letter("H");
    case "End": return letter("F");
    case "PageUp": return tilde(5);
    case "PageDown": return tilde(6);
    case "Insert": return tilde(2);
    case "Delete": return tilde(3);
  }
  const fn = /^F([1-9]|1[0-2])$/.exec(e.key);
  if (fn) {
    const n = +fn[1];
    const lett: Record<number, string> = { 1: "P", 2: "Q", 3: "R", 4: "S" };
    if (lett[n]) return letter(lett[n]);
    const tn: Record<number, number> = { 5: 15, 6: 17, 7: 18, 8: 19, 9: 20, 10: 21, 11: 23, 12: 24 };
    if (tn[n]) return tilde(tn[n]);
  }
  if ([...e.key].length === 1) {
    // Printable: keycode is the unshifted (lowercase) codepoint; associated text
    // (the actually-typed char) goes in the 3rd field on press without ctrl/alt/meta.
    const cp = e.key.codePointAt(0)!;
    const base = e.key.toLowerCase().codePointAt(0)!;
    if (event !== 3 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      return `${CSI}${base};${mods}:${event};${cp}u`;
    }
    return u(base);
  }
  return null;
}

function kittyKeyHandler(e: KeyboardEvent, id: string): boolean {
  // App keybindings still win on graphics tabs (⌘⇧P palette, ⌘w close, …).
  if (e.type === "keydown" && runMatchingCommand(e)) {
    e.stopPropagation();
    return false;
  }
  if (e.type !== "keydown" && e.type !== "keyup") return true;
  // Standalone modifier keys: skip (pages read modifier state off real keys).
  if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") {
    e.preventDefault();
    return false;
  }
  const seq = kittyKeySeq(e);
  if (!seq) return true;
  e.preventDefault();
  invoke("write_pty", { id, data: seq }).catch(console.error);
  return false;
}

// Open-tab ids in most-recently-focused order (front = newest). Drives the
// "send to" picker's ordering; updated whenever a terminal becomes active.
let tabRecency: string[] = [];
export function touchTab(id: string) {
  tabRecency = [id, ...tabRecency.filter((x) => x !== id)];
}

// Persisted open-tab list (for reattach after reload). Keyed by tab name.
export function recordTab(name: string, command: string | null, cwd: string | null, graphics = false) {
  const cur = store.get().openTabs;
  if (cur.some((t) => t.name === name)) return;
  store.set({ openTabs: [...cur, { name, command, cwd, graphics }] });
}
export function forgetTab(id: string) {
  store.set({ openTabs: store.get().openTabs.filter((t) => sessionId(t.name) !== id) });
}

// Browser-like history of which session you went to and when. Logged into the
// unified activity store (source='session'), deduped on consecutive same-tab,
// suppressed during boot replay so restoring tabs doesn't spam the timeline.
let replaying = false;
let lastVisited: string | null = null;
export function setReplaying(v: boolean) {
  replaying = v;
}
function logTabVisit(name: string) {
  if (replaying || name === lastVisited) return;
  lastVisited = name;
  invoke("activity_log", {
    source: "session",
    kind: "focus",
    title: name,
    text: `went to ${name}`,
  }).catch(() => {});
}

// Quick-start sessions launch their agent the first time the tmux session is created.
const QUICK_CMD: Record<string, string> = {
  claude: "claude",
  opencode: "opencode",
};

// The tab's working dir. The recorded launch cwd is often null/HOME (the user
// cd's then runs the agent inside a shell), so prefer the LIVE tmux pane cwd
// (store.sessions[].paths) — that's where claude/opencode actually keyed their
// session — and fall back to the launch cwd.
export function tabMetaById(id: string): { cwd: string; command: string | null } | null {
  const t = tabs.get(id);
  if (!t) return null;
  const rec = store.get().openTabs.find((o) => o.name === t.name);
  const live = store.get().sessions.find((s) => s.name === t.name);
  const cwd = live?.paths?.[0] || rec?.cwd || null;
  return cwd ? { cwd, command: rec?.command ?? null } : null;
}
// Every candidate cwd for a tab's session lookup: each live tmux pane cwd, then
// the recorded launch cwd. claude keys its ledger dir by the cwd it was launched
// in, which may be any of these (a pane can cd elsewhere), so we probe them all.
export function tabCwds(id: string): string[] {
  const t = tabs.get(id);
  if (!t) return [];
  const rec = store.get().openTabs.find((o) => o.name === t.name);
  const live = store.get().sessions.find((s) => s.name === t.name);
  const cands = [...(live?.paths ?? []), rec?.cwd].filter(Boolean) as string[];
  return [...new Set(cands)];
}

// Cheap front gate so a ⌘-click on a plain word does nothing (no window hide):
// a URL scheme, a www. host, or a token bearing a slash/dot/tilde path marker.
export function looksOpenable(tok: string): boolean {
  return /:\/\//.test(tok) || /^www\./.test(tok) || /[/~]/.test(tok) || /\.[a-z0-9]/i.test(tok);
}

// ---- per-terminal zoom (font size, persisted per tab id) ----
// The terminal that currently holds keyboard focus. ⌘+/-/0 zoom THAT terminal's
// font when set; otherwise they fall back to the webview/chrome zoom above. Set
// on the xterm textarea focus/blur in openTab.
let focusedTermId: string | null = null;
export const getFocusedTermId = () => focusedTermId;
const TERM_FONT_DEFAULT = 13;
const TERM_FONT_MIN = 6;
const TERM_FONT_MAX = 40;
const termFontSize = (id: string) => store.get().tabZoom[id] ?? TERM_FONT_DEFAULT;
function applyTermFontSize(id: string, px: number) {
  const t = tabs.get(id);
  if (!t) return;
  t.term.options.fontSize = px;
  t.fit.fit(); // reflow cols/rows + tell the pty via onResize
}
function setTermFontSize(id: string, px: number) {
  const clamped = Math.min(TERM_FONT_MAX, Math.max(TERM_FONT_MIN, px));
  store.set({ tabZoom: { ...store.get().tabZoom, [id]: clamped } });
  applyTermFontSize(id, clamped);
}
// Route a zoom gesture: a focused terminal zooms its own font; else the chrome.
export function zoomGesture(delta: number) {
  if (focusedTermId && tabs.has(focusedTermId)) {
    setTermFontSize(focusedTermId, termFontSize(focusedTermId) + (delta > 0 ? 1 : -1));
  } else {
    nudgeZoom(delta);
  }
}
export function zoomResetGesture() {
  if (focusedTermId && tabs.has(focusedTermId)) {
    setTermFontSize(focusedTermId, TERM_FONT_DEFAULT);
  } else {
    resetZoom();
  }
}

// The word/path token under the pointer, for a ⌘-click miss (no link hit). Uses
// the screen-cell geometry to map clientX/Y to a buffer cell, then expands to the
// surrounding non-whitespace run and strips wrapping punctuation. A quoted span
// under the cursor wins (so spaces inside quotes stay together).
function wordAt(id: string, clientX: number, clientY: number): string {
  const t = tabs.get(id);
  if (!t) return "";
  const screen = (t.el.querySelector(".xterm-screen") as HTMLElement | null) ?? t.el;
  const rect = screen.getBoundingClientRect();
  const cellH = rect.height / t.term.rows || 1;
  const cellW = rect.width / t.term.cols || 1;
  const row = Math.max(0, Math.min(t.term.rows - 1, Math.floor((clientY - rect.top) / cellH)));
  const col = Math.max(0, Math.min(t.term.cols - 1, Math.floor((clientX - rect.left) / cellW)));
  const buf = t.term.buffer.active;
  const line = buf.getLine(buf.viewportY + row);
  if (!line) return "";
  const text = line.translateToString(true);
  const quoted = quotedSpanAt(text, col);
  if (quoted) return quoted;
  if (col >= text.length || /\s/.test(text[col] ?? "")) return "";
  let lo = col;
  let hi = col;
  while (lo > 0 && !/\s/.test(text[lo - 1])) lo--;
  while (hi < text.length - 1 && !/\s/.test(text[hi + 1])) hi++;
  return text
    .slice(lo, hi + 1)
    .replace(/^[('"<[{]+/, "")
    .replace(/[.,;:)\]}>'"]+$/, "");
}

// opts let a Space override the agent command and launch cwd; plain sessions
// fall back to QUICK_CMD and the backend default (HOME).
export function openTab(
  name: string,
  opts: { command?: string | null; cwd?: string | null; graphics?: boolean } = {},
) {
  const id = sessionId(name);
  if (tabs.has(id)) {
    if (hasTermPanel(id)) {
      activate(id);
      return;
    }
    // Stale bookkeeping: our tabs Map still has this id but dockview's own
    // panel for it is already gone — a removal whose onDidRemovePanel we
    // never observed (or a close/reopen fast enough to race it). The old
    // silent `activate(id)` here was a true no-op in this case (nothing to
    // activate), which read as "reopen does nothing" with no error anywhere.
    // Self-heal: drop the orphaned entry and fall through to build fresh.
    const stale = tabs.get(id);
    stale?.overlay?.dispose();
    stale?.term.dispose();
    stale?.el.remove();
    tabs.delete(id);
    console.warn("[openTab] stale tabs entry for", id, "— rebuilding");
  }

  // openTab is mechanical: it opens exactly the command it's handed. Resume is a
  // deliberate gesture (⌘⇧T reopen, or the worktree "auto-resume latest" toggle),
  // resolved by the caller — NOT here — so "new · X" stays a fresh session.

  // Visible confirmation that a reopen actually resumed (vs started fresh) —
  // matches either reopen path since both bake the --resume/--session flag in.
  const rm = opts.command?.match(/\s--(?:resume|session)\s+(\S+)/);
  if (rm) {
    console.log("[resume]", name, opts.command);
    flashStatus(`↻ resuming ${rm[1].slice(0, 8)}`);
  }

  const el = document.createElement("div");
  el.className = "term-host";
  const inspector = document.createElement("div");
  inspector.className = "term-inspector";
  inspector.setAttribute("popover", "manual");
  document.body.appendChild(inspector);
  const hideInspector = () => { try { inspector.hidePopover(); } catch { inspector.removeAttribute("data-open"); } };
  let inspectorRequest = 0;
  let commandHeld = false;
  let inspectorToken = "";
  let inspectorCwd = "";
  let inspectorRef: { path: string; line?: number } | null = null;
  inspector.addEventListener("mouseenter", () => { inspector.dataset.inside = "1"; });
  inspector.addEventListener("mouseleave", () => {
    delete inspector.dataset.inside;
    if (!commandHeld) hideInspector();
  });
  inspector.addEventListener("click", (e) => {
    const action = (e.target as HTMLElement).closest<HTMLElement>("[data-inspector-action]")?.dataset.inspectorAction;
    if (!action || !inspectorRef) return;
    if (action === "preview") openPreviewPanel(inspectorRef.path, inspectorRef.line);
    if (action === "search") void dispatchClick(inspectorToken, inspectorCwd);
    if (action === "copy") void navigator.clipboard.writeText(inspectorRef.path);
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Meta") commandHeld = true;
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Meta") {
      commandHeld = false;
      if (!inspector.matches(":hover")) hideInspector();
    }
  });
  // Live in the pool (in-document, so xterm can measure) until dockview adopts
  // it into the terminal's panel.
  document.getElementById("panel-pool")!.appendChild(el);

  const term = new Terminal({
    // Menlo renders the body text; the rest are per-glyph fallbacks for
    // powerline separators + Nerd Font icons (PUA codepoints Menlo lacks). The
    // "Nerd Font" names win if installed; "for Powerline" is the guaranteed
    // separator fallback already on disk. Install full icons with:
    //   brew install --cask font-hack-nerd-font
    fontFamily: termFontFamily(), // Menlo chain, or Perfect DOS VGA when Super XP is on
    fontSize: termFontSize(id), // persisted per-tab zoom (default 13)
    cursorBlink: true,
    allowProposedApi: true,
    // tmux mouse mode is on (wheel-scroll + forwarding to claude/opencode), which
    // makes a plain drag go to tmux copy-mode and fight native selection. Hold
    // Option to force xterm's own selection instead, iTerm-style.
    macOptionClickForcesSelection: true,
    theme: THEMES[store.get().skin],
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);

  // Graphics sessions (awrit) get an overlay canvas for kitty-graphics frames
  // forwarded by the Rust proxy, and skip tmux (which filters graphics APCs).
  // Infer from the command too, so reload records predating the graphics flag
  // (and any awrit launch) still restore the overlay.
  const cmd = opts.command ?? QUICK_CMD[name] ?? null;
  const graphics = opts.graphics ?? /^\s*awrit\b/.test(cmd ?? "");
  const overlay = graphics ? new GraphicsOverlay(el) : undefined;
  const live = store.get().sessions.find((s) => s.name === name);
  const harness = detectHarness(opts.command ?? cmd, live?.commands?.[0]);
  tabs.set(id, { id, name, term, fit, el, graphics, overlay, harness, outputTail: "" });
  el.dataset.harness = harness.id ?? "unknown";
  el.dataset.harnessConfidence = harness.confidence;

  // OSC 52 -> macOS clipboard. tmux (set-clipboard on) emits this when a mouse
  // drag selects text in copy-mode, and TUIs (opencode) emit it on their own
  // copy. xterm doesn't touch the system clipboard on its own (security), so
  // without this bridge a selection lands only in tmux's buffer and ⌘V pastes
  // nothing — the "can't copy after leaving opencode" case.
  term.parser.registerOscHandler(52, (data) => {
    // data = "<targets>;<base64|?>" (targets e.g. "c"/"p"; "?" is a read query).
    const b64 = data.slice(data.indexOf(";") + 1);
    if (!b64 || b64 === "?") return true;
    try {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      void navigator.clipboard.writeText(new TextDecoder().decode(bytes));
    } catch {
      /* malformed payload: ignore */
    }
    return true; // handled; don't pass through
  });

  // ⌘-click a token to run its clickRules action (url->open, path->editor,
  // else->rg). xterm's link provider gives the hover underline + pointer and
  // correct hit-testing for the openable subset; its activate routes through the
  // same dispatchClick as the miss handler below. ⌘ gates it so plain clicks
  // (cursor placement etc.) still reach the TUI.
  term.registerLinkProvider({
    provideLinks(y, cb) {
      const line = term.buffer.active.getLine(y - 1); // y is 1-based absolute row
      if (!line) return cb(undefined);
      const text = line.translateToString(true);
      const links: ILink[] = [];
      const activate = (e: MouseEvent, t: string) => {
        if (!e.metaKey) return; // ⌘ required; plain click stays with the app
        dispatchClick(t, tabMetaById(id)?.cwd ?? "");
      };
      // Quoted spans first: '…'/"…"/`…` is one openable unit (paths with spaces).
      // Record the quote columns so the \S+ pass below skips the fragments inside.
      const spans: Array<{ o: number; c: number }> = [];
      for (const m of text.matchAll(/(['"`])(.+?)\1/g)) {
        const inner = m[2];
        if (!inner.trim()) continue;
        const o = m.index ?? 0; // opening-quote col
        const c = o + m[0].length - 1; // closing-quote col
        spans.push({ o, c });
        const start = o + 1; // inner content col (0-based)
        links.push({
          text: inner,
          range: { start: { x: start + 1, y }, end: { x: start + inner.length, y } },
          activate,
        });
      }
      for (const m of text.matchAll(/\S+/g)) {
        const idx0 = m.index ?? 0;
        if (spans.some((s) => idx0 >= s.o && idx0 <= s.c)) continue; // inside a quoted span
        const raw = m[0];
        // Strip wrapping punctuation, tracking the offset for column math.
        const lead = raw.match(/^[('"<[{]+/)?.[0].length ?? 0;
        const trail = raw.match(/[.,;:)\]}>'"]+$/)?.[0].length ?? 0;
        const tok = raw.slice(lead, raw.length - trail);
        if (!tok || !looksOpenable(tok)) continue;
        const start = idx0 + lead; // 0-based col
        links.push({
          text: tok,
          range: { start: { x: start + 1, y }, end: { x: start + tok.length, y } },
          activate,
        });
      }
      cb(links);
    },
  });

  // ⌘-click that ISN'T on an openable link (no hover underline): take the
  // selection, else the word under the cursor, and run its clickRules action
  // (the catch-all rule greps from cwd). Capture phase so we can swallow it
  // before the TUI sees the click; openable hits fall through to the link
  // provider above (which the linkifier activates on mouseup).
  el.addEventListener(
    "mousemove",
    (e) => {
      if (!e.metaKey) { inspectorRequest++; hideInspector(); return; }
      const token = wordAt(id, e.clientX, e.clientY);
      const cwd = tabMetaById(id)?.cwd ?? "";
      if (!token || !looksOpenable(token)) { hideInspector(); return; }
      const ref = resolveReference(token, cwd);
      inspectorToken = token;
      inspectorCwd = cwd;
      inspectorRef = ref;
      const request = ++inspectorRequest;
      inspector.innerHTML = `<strong>${escapeHtml(token)}</strong><span>${escapeHtml(clickIntent(token, cwd))}</span><small>${escapeHtml(ref?.path ?? (cwd || "home"))}</small>`;
      const inspectorW = Math.min(620, window.innerWidth - 16);
      const inspectorH = Math.min(260, window.innerHeight - 16);
      inspector.style.left = `${Math.max(8, Math.min(e.clientX + 12, window.innerWidth - inspectorW - 8))}px`;
      inspector.style.top = `${Math.max(8, Math.min(e.clientY + 14, window.innerHeight - inspectorH - 8))}px`;
      try { inspector.showPopover(); } catch { inspector.dataset.open = "1"; }
      if (ref) {
        void invoke<string>("read_text", { path: ref.path }).then((text) => {
          if (request !== inspectorRequest) return;
          void inlineSnippetHtml(ref.path, text, store.get().mode === "dark").then((html) => {
            if (request !== inspectorRequest) return;
            inspector.innerHTML = `<strong>${escapeHtml(token)}</strong><span>${escapeHtml(clickIntent(token, cwd))}</span><small>${escapeHtml(ref.path)}</small>${html}<div class="term-inspector-actions"><button data-inspector-action="preview">preview</button><button data-inspector-action="search">search</button><button data-inspector-action="copy">copy path</button></div>`;
          });
        }).catch(() => {});
      }
    },
    { capture: true },
  );

  el.addEventListener(
    "mousedown",
    (e) => {
      // tmux mouse mode reports button-2 into the PTY before the browser's
      // contextmenu event can reach our global menu. Claim it at the host edge,
      // then synthesize the normal event so favorites/terminal actions use the
      // same context-menu path every time.
      if (e.button === 2) {
        e.preventDefault();
        e.stopPropagation();
        el.dispatchEvent(new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: e.clientX,
          clientY: e.clientY,
          screenX: e.screenX,
          screenY: e.screenY,
        }));
        return;
      }
      if (!e.metaKey || e.button !== 0) return;
      const sel = term.getSelection().trim();
      const word = sel || wordAt(id, e.clientX, e.clientY);
      if (!word) return;
      if (!sel && looksOpenable(word)) return; // link provider handles this hit
      e.preventDefault();
      e.stopPropagation();
      dispatchClick(word, tabMetaById(id)?.cwd ?? "");
    },
    { capture: true },
  );

  // Click anywhere in the host (incl. padding around the xterm) focuses the
  // terminal, so keyboard + scroll work without hunting for the text area.
  el.addEventListener("mousedown", () => term.focus());

  // Track which terminal owns keyboard focus so ⌘+/-/0 zoom the right one.
  term.textarea?.addEventListener("focus", () => {
    focusedTermId = id;
  });
  term.textarea?.addEventListener("blur", () => {
    if (focusedTermId === id) focusedTermId = null;
  });

  term.onData((data) => invoke("write_pty", { id, data }).catch(console.error));
  term.onResize(({ cols, rows }) =>
    invoke("resize_pty", { id, cols, rows, ...cellDims(term) }).catch(console.error),
  );

  // iTerm2-style word/line editing. xterm doesn't emit these by default on mac,
  // so we intercept and write the readline/emacs control sequences the shell
  // (and claude/opencode) understand. Returning false stops xterm's own handling
  // (e.g. Alt+b inserting "∫").
  term.attachCustomKeyEventHandler((e) => {
    // Graphics tabs (awrit) speak the kitty keyboard protocol; handle before the
    // keydown-only legacy path so key releases are reported too.
    if (graphics) return kittyKeyHandler(e, id);
    if (e.type !== "keydown") return true;
    // App command? Run it, swallow the key (no pty write), and stop it bubbling
    // to the window keymap listener so it doesn't fire twice.
    if (runMatchingCommand(e)) {
      e.stopPropagation();
      return false;
    }
    const send = (data: string) => {
      // preventDefault is essential: returning false stops xterm from processing
      // the key but does NOT stop the browser default. For keys like Shift+Enter
      // the default inserts a newline into xterm's hidden helper <textarea>, which
      // xterm later flushes on an `input` event — leaking a stray \n at random
      // times (and Alt+Left would trigger browser back-nav). Swallow it here.
      e.preventDefault();
      invoke("write_pty", { id, data }).catch(console.error);
      return false;
    };
    const only = (a: boolean, b: boolean, c: boolean) => a && !b && !c;
    // Shift+Enter: insert a newline instead of submitting. At the byte level
    // Shift+Enter == Enter (both \r), and tmux squashes \r/\n/extended-key
    // sequences down to a bare \n before they reach the app — so the app can't
    // tell it from a submit. The robust path is bracketed paste: wrap one \n in
    // the paste markers and the app inserts it as a literal, editable newline
    // (same as pasting multi-line text), no submit. Survives tmux untouched.
    // Verified through `tmux new-session`; \r\n becomes \n\n, so use one \n.
    if (e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey)
      return send("\x1b[200~\n\x1b[201~");
    if (only(e.altKey, e.metaKey, e.ctrlKey)) {
      if (e.key === "ArrowLeft") return send("\x1bb"); // word back
      if (e.key === "ArrowRight") return send("\x1bf"); // word forward
      if (e.key === "Backspace") return send("\x1b\x7f"); // delete word back
    }
    if (only(e.metaKey, e.altKey, e.ctrlKey)) {
      // Cmd+C: xterm paints its selection in its own layer (not a DOM selection)
      // so copy only when there IS a selection, else fall through. Paste is left
      // to xterm's native handler (its textarea paste event) — handling it here
      // too double-pastes.
      if (e.key === "c" && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection()).catch(console.error);
        return false;
      }
      if (e.key === "ArrowLeft") return send("\x01"); // line start (Ctrl-A)
      if (e.key === "ArrowRight") return send("\x05"); // line end (Ctrl-E)
      if (e.key === "Backspace") return send("\x15"); // kill to line start (Ctrl-U)
    }
    return true;
  });

  // Fit AFTER layout so the pty spawns at the real grid size, not the pre-layout
  // 80x24 default that leaves full-screen TUIs (opencode) clipped.
  const command = cmd;
  const cwd = opts.cwd ?? null;
  recordTab(name, command, cwd, graphics); // survives reload; tmux session outlives the webview
  requestAnimationFrame(() => {
    fit.fit();
    const { cols, rows } = term;
    invoke("open_session", {
      id, name, command, cwd, cols, rows, graphics, ...cellDims(term),
    }).catch(console.error);
  });

  // Hand the host element to dockview as a flat, draggable/splittable panel.
  // Adding it makes it active, which fires onTermActivate -> onTermShown.
  addTermPanel(id, tabTitle(name), el);
  activate(id);
  if (store.get().pinnedTabs.length) reflowPinnedTabs();
}

// Make a terminal the active dockview panel. The store/active-sync + focus is
// done in onTermShown when dockview reports the active change.
export function activate(id: string) {
  if (tabs.has(id) || browserTabs.has(id)) focusTermPanel(id);
}

// Focus a terminal reliably across a tab switch. A single rAF races dockview:
// the panel may still be hidden that frame (focus on a display:none element is a
// no-op) and dockview can move focus right after. Retry on rAF + a short timeout
// so the keyboard (and keyboard scroll) land in the panel body without a click.
function focusTermSoon(id: string) {
  const go = () => tabs.get(id)?.term.focus();
  requestAnimationFrame(go);
  setTimeout(go, 60);
}

// dockview reports a terminal panel became active (tab click, open, or a
// neighbour closing). Sync the store, log the visit, refit, focus.
export function onTermShown(id: string) {
  const b = browserTabs.get(id);
  if (b) {
    setActive(id);
    touchTab(id);
    requestAnimationFrame(() => b.view.focus());
    renderSessionActive();
    return;
  }
  const t = tabs.get(id);
  if (!t) return;
  setActive(id);
  touchTab(id);
  logTabVisit(t.name);
  void warmTurns(id); // warm the ledger so right-click turn-identify stays sync
  requestAnimationFrame(() => {
    t.fit.fit();
    invoke("resize_pty", {
      id, cols: t.term.cols, rows: t.term.rows, ...cellDims(t.term),
    }).catch(() => {});
  });
  focusTermSoon(id);
  renderSessionActive();
}

// Close a terminal: remove its dockview panel; dockview then fires
// onDidRemovePanel -> onTermClosed which disposes the xterm + pty.
export function closeTab(id: string) {
  if (tabs.has(id) || browserTabs.has(id)) removeTermPanel(id);
}

// Stack of recently closed tabs for reopen (⌘⇧T). In-memory only. A tmux session
// survives a tab close, so reopen reattaches by name and the agent is still
// alive; the stored command/cwd only matter if the session was actually killed.
// Timestamped + TTL'd (see reopenLastTab).
export const closedTabs: { tab: OpenTab; ts: number }[] = [];
// Runs close-time agent teardown one-at-a-time; see onTermClosed for why.
let closeChain: Promise<unknown> = Promise.resolve();
// Await all in-flight close teardown (kill_session / close_pty). Reopen paths
// call this BEFORE recreating a session name so a recreated session can't be
// reattached to a dying corpse or torn down by a kill still queued from its close.
export const settleClosures = () => closeChain;

// dockview removed a terminal panel (close button, menu, or closeTab). Tear
// down the live resources and re-point active at a surviving terminal.
export function onTermClosed(id: string) {
  const b = browserTabs.get(id);
  if (b) {
    b.view.dispose();
    b.el.remove();
    browserTabs.delete(id);
    forgetTab(id); // don't reopen a browser tab the user closed
    invoke("cdp_close", { id }).catch(() => {});
    if (activeId() === id) {
      const next = tabs.keys().next();
      const nextId = next.done ? (browserTabs.keys().next().value ?? null) : next.value;
      setActive(nextId ?? null);
      if (nextId) activate(nextId);
    }
    renderSessionActive();
    return;
  }
  const t = tabs.get(id);
  if (!t) return;
  const name = t.name;
  // Capture before teardown: cwd/command + the live foreground proc decide
  // whether this is an agent tab to EXIT (free RAM) vs a shell we just detach.
  const tabMeta = tabMetaById(id);
  const live = store.get().sessions.find((s) => s.name === name);
  const proc = foregroundProc(live?.commands ?? []);
  const isGraphics = t.graphics ?? false;
  t.overlay?.dispose();
  t.term.dispose();
  t.el.remove();
  tabs.delete(id);
  // Remember it for reopen (⌘⇧T), carrying the original command/cwd.
  const meta = store.get().openTabs.find((o) => o.name === name);
  closedTabs.push({
    tab: { name, command: meta?.command ?? null, cwd: meta?.cwd ?? null },
    ts: Date.now(),
  });
  forgetTab(id); // don't reattach a tab the user closed
  // Agent tab → kill the tmux session so claude/opencode isn't left burning RAM
  // (recording its id for --resume first, keyed by session name). Anything else →
  // detach the pty; the tmux session survives (so a reload reattaches it). Decided
  // async because the on-disk session probe is async; see exitOrDetachTab.
  // Serialize teardown: two near-simultaneous closes must NOT interleave their
  // resumeTabs read-modify-write, or both probe-record the same newest-in-cwd id
  // and the 2nd reopen resumes the 1st's session ("rando old session"). Chaining
  // lets each close fully claim its id before the next one probes.
  closeChain = closeChain.then(() => exitOrDetachTab(id, name, tabMeta, proc, isGraphics)).catch(() => {});
  if (activeId() === id) {
    const next = tabs.keys().next();
    const nextId = next.done ? null : next.value;
    setActive(nextId);
    if (nextId) activate(nextId);
  }
  renderSessionActive();
  refreshSessions();
}

// Decide a closed tab's fate: an agent tab is KILLED (frees the RAM claude/
// opencode hold) after best-effort recording its session id for --resume;
// anything else just detaches (tmux survives a reload). The kill fires whenever
// we believe an agent is running — it is NOT gated on resolving the session id,
// so a stale id lookup can't leave claude alive. The agent writes its jsonl
// incrementally, so killing mid-run stays resumable.
async function exitOrDetachTab(
  id: string,
  name: string,
  meta: { cwd: string; command: string | null } | null,
  proc: string,
  isGraphics = false,
) {
  // Graphics tabs (awrit) are never tmux sessions; close_pty kills the child so
  // it can't orphan and hold its profile lock.
  if (isGraphics) {
    invoke("close_pty", { id }).catch(() => {});
    return;
  }
  const sessions = meta ? await tabSessions(tabCwds(id), meta.command) : [];
  const bin = (meta?.command ?? "").trim().split(/\s+/)[0]?.split("/").pop() ?? "";
  // Agent when: the live foreground proc looks like one (claude's version title,
  // opencode.exe, node/bun), the launch command names one, or the proc was
  // unknown (stale list) but the cwd has an on-disk agent session. A known
  // non-agent proc (vim, …) is never killed.
  const isAgent =
    looksLikeAgentProc(proc) ||
    KNOWN_RESUME[bin] != null ||
    (proc === "" && sessions.length > 0);
  if (!isAgent) {
    invoke("close_pty", { id }).catch(() => {}); // tmux session keeps running
    return;
  }
  // Resume id is keyed by SESSION NAME — the stable identity of this tab. A claude
  // session we launched already has the AUTHORITATIVE id recorded at launch
  // (newAgentLaunch's --session-id), so DON'T clobber it with the close-time cwd
  // probe, which only resolves "latest jsonl in this cwd" and would grab a sibling
  // when several sessions share the cwd. The probe is a fallback for agents we
  // didn't launch with a chosen id (e.g. opencode, or a reattached external one).
  if (!store.get().resumeTabs[name]) {
    // Skip ids already claimed by another tab's record so same-cwd siblings each
    // resume a DISTINCT session (the "rando old session" fix). Serialized teardown
    // (closeChain) guarantees prior closes have recorded before we read here.
    const claimed = new Set(Object.values(store.get().resumeTabs).map((r) => r.sessionId));
    const s = meta ? await unclaimedSession(meta, claimed) : null;
    if (s) {
      store.set({
        resumeTabs: { ...store.get().resumeTabs, [name]: { editor: s.editor, sessionId: s.sessionId } },
      });
      console.log("[resume] recorded (probe)", name, "->", s.editor, s.sessionId.slice(0, 8));
    } else {
      console.log("[resume] killed", name, "(no id to resume)");
    }
  } else {
    console.log("[resume] killed", name, "(keeping launch id)");
  }
  await invoke("kill_session", { name }).catch(console.error); // kill regardless of id resolution
  refreshSessions();
}

// Refit one terminal (dockview reports its panel group resized).
export function fitTerm(id: string) {
  const t = tabs.get(id);
  if (!t) return;
  t.fit.fit();
  invoke("resize_pty", {
    id, cols: t.term.cols, rows: t.term.rows, ...cellDims(t.term),
  }).catch(() => {});
}

// Drop text into the active terminal (a row's text/url paste target).
export function pasteToActive(data: string) {
  const id = activeId();
  if (!id || !data) return;
  invoke("write_pty", { id, data: sanitizePaste(data) }).catch(console.error);
  tabs.get(id)?.term.focus();
}

// Write text into a terminal's pty (path or selection, space-terminated so the
// next token is separate) and focus it.
export async function sendTextToTab(id: string, text: string) {
  if (!tabs.has(id)) return;
  await invoke("write_pty", { id, data: text }).catch(console.error);
  tabs.get(id)?.term.focus();
}

// Open terminals in most-recently-focused order, for the send picker.
export function recentTabs(): Tab[] {
  const seen = new Set<string>();
  const out: Tab[] = [];
  for (const id of tabRecency) {
    const t = tabs.get(id);
    if (t && !seen.has(id)) {
      seen.add(id);
      out.push(t);
    }
  }
  // Any open tab not yet in the recency list (e.g. reattached on boot) trails.
  for (const [id, t] of tabs) if (!seen.has(id)) out.push(t);
  return out;
}
// todo(lifecycle): move PTY listener ownership and teardown into the reactive runtime
// todo(test): exercise open, resize, close, reload, and tmux reattach as one lifecycle test
