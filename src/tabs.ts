// Tab management that sits above the raw terminal registry: visual tab
// navigation (⌘1..9 / next / prev across all dock panels), pinned tabs (📌 title
// prefix + left-float reflow), closed-tab reopen (⌘⇧T with resume), the tab
// title composition, and "new tab at pwd".
import { store } from "./state";
import {
  allPanelIds,
  activePanelId,
  focusPanelById,
  closeActivePanel,
  customTermTitle,
  setTermTitle,
  moveTermPanel,
  reopenClosedPanel,
  latestClosedPanel,
} from "./reactdock";
import { sessionId, activeId, flashStatus, baseName, tmuxName, logLine } from "./core";
import { tabs, openTab, closedTabs, settleClosures } from "./terminal";
import { refreshSessions, resumeIdIsLive, resumeLaunch, dropResumeTab } from "./worktrees";
import { reopenKind } from "./0_reopenOrder";
import { settings } from "./0_settings";

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
export function focusTabByOffset(delta: number) {
  const ids = visualTabIds();
  if (ids.length < 2) return;
  const cur = activePanelId() ?? activeId();
  const i = cur ? ids.indexOf(cur) : -1;
  const next = ids[((i < 0 ? 0 : i) + delta + ids.length) % ids.length];
  focusPanelById(next);
}

// Go to the Nth tab (1-based). 9 always jumps to the last, browser-style.
export function focusTabN(n: number) {
  const ids = visualTabIds();
  if (!ids.length) return;
  const idx = n >= 9 ? ids.length - 1 : n - 1;
  if (ids[idx]) focusPanelById(ids[idx]);
}

// Close the focused tab (cmd/ctrl+W). Closes dockview's ACTIVE panel, not the
// store.active terminal — those diverge once focus lands on a non-terminal panel
// (tmux v2, …), which made cmd+W close a stale sibling. Terminal teardown +
// closed-tab capture still run via onTermClosed.
export function closeActiveTab() {
  closeActivePanel();
}

// Session name behind the active tab id (strips the "s:" prefix), or "".
function activeTabName(): string {
  const id = activeId();
  return id ? id.slice(sessionId("").length) : "";
}

// ---- pinned terminal tabs (persisted by session name) ----
// Visual is a 📌 prefix on the dockview tab title, pushed via reactdock's
// setTermTitle (a public API) so we don't have to touch reactdock's renderer.
export const isPinnedTab = (name: string) => settings.pinnedTabs.$().includes(name);
// What tmux calls this session's active window, blank unless someone renamed
// it: Rust drops #{window_name} that only echoes the command or session name.
export const tmuxTitle = (name: string) =>
  store.get().sessions.find((s) => s.name === name)?.title ?? "";

// Base = the durable rename override (store.tabTitles), else tmux's own window
// name, else the session name; the pin prefix rides on top so all three compose.
export const tabTitle = (name: string) => {
  const base = customTermTitle(sessionId(name)) ?? (tmuxTitle(name) || name);
  return isPinnedTab(name) ? `📌 ${base}` : base;
};

// Last title pushed per session, so a tmux poll that changed nothing does not
// re-enter dockview once per tab per tick.
const published = new Map<string, string>();

export function applyTabTitle(name: string) {
  const next = tabTitle(name);
  published.set(name, next);
  setTermTitle(sessionId(name), next);
}

// tmux renames arrive on the next list_sessions poll, so republish every open
// tab whose composed title moved. Wired to store.subscribe(["sessions"]).
export function syncTabTitlesFromTmux() {
  const prefix = sessionId("");
  for (const id of tabs.keys()) {
    const name = id.slice(prefix.length);
    const next = tabTitle(name);
    if (published.get(name) === next) continue;
    published.set(name, next);
    setTermTitle(id, next);
  }
}
export function togglePinTab(name: string) {
  if (!name) return;
  const cur = settings.pinnedTabs.$();
  settings.pinnedTabs.$(cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name]);
  applyTabTitle(name);
  reflowPinnedTabs();
}

// Float pinned tabs to the left of the bar, in pinnedTabs order. Each open
// pinned tab is moved to its slot (0,1,2,…); processing in order lets earlier
// pins settle first so the final left-to-right matches the list.
export function reflowPinnedTabs() {
  let i = 0;
  for (const name of settings.pinnedTabs.$()) {
    if (tabs.has(sessionId(name))) moveTermPanel(sessionId(name), i++);
  }
}

// Stack of recently closed tabs for reopen (⌘⇧T). In-memory only. Timestamped +
// TTL'd: this stack lives for the whole app session (days), and without an expiry
// a reopen whose real target silently failed to surface used to read as "press
// ⌘⇧T again" — which pops the NEXT entry down: a tab closed hours or days ago,
// reopening as a "random old session out of nowhere".
const CLOSED_TAB_TTL_MS = 30 * 60 * 1000;
export async function reopenLastTab() {
  while (closedTabs.length && Date.now() - closedTabs[closedTabs.length - 1].ts > CLOSED_TAB_TTL_MS) {
    closedTabs.pop();
  }
  const panel = latestClosedPanel();
  const terminal = closedTabs[closedTabs.length - 1];
  if (panel && reopenKind(panel.order, terminal?.order ?? null) === "panel") {
    logLine(`[tab.reopen] selected=panel id=${JSON.stringify(panel.id)}`);
    reopenClosedPanel();
    return;
  }
  const entry = closedTabs.pop();
  if (!entry) {
    logLine("[tab.reopen] selected=none");
    flashStatus("nothing to reopen");
    return;
  }
  const last = entry.tab;
  logLine(`[tab.reopen] selected=terminal name=${JSON.stringify(last.name)}`);
  // Wait for the close's teardown to finish before recreating this name. The
  // close runs exitOrDetachTab on closeChain (async kill_session / close_pty); if
  // we recreate first, either tmux -A reattaches the dying corpse (dropping the
  // --resume command) or the still-queued kill lands AFTER our new session and
  // tears IT down — the "double reopen" failure. Awaiting frees the name first.
  //
  // resumeTabs is READ after this await too, not before: exitOrDetachTab writes
  // it from inside that same closeChain (the async on-disk session probe), so
  // reading it before the await could see the pre-close value — last reopen's
  // id, or nothing — and silently replay a stale/blank command instead of this
  // close's resume. That's the "works once, breaks the second time" failure:
  // the first close's record happened to already be in the store by the time
  // you reopened, masking the race until a faster close/reopen cycle hit it.
  await settleClosures();
  // ⌘⇧T is the "bring back what I just closed" gesture — so if we exited an agent
  // in this SESSION NAME, resume its conversation (name-keyed record) instead of
  // replaying the stale original command. The record is kept (not consumed) so the
  // name->id identity is stable across repeated reopens; "new · X" overwrites it.
  const killed = settings.resumeTabs.$()[last.name];
  let command = last.command;
  if (killed && last.cwd && (await resumeIdIsLive(killed.editor, last.cwd, killed.sessionId))) {
    command = resumeLaunch(killed.editor, killed.sessionId);
    console.log("[resume] ⌘⇧T", last.name, "->", command);
  } else if (killed) {
    console.warn("[resume] ⌘⇧T", last.name, "dead id", killed.sessionId.slice(0, 8), "— dropping");
    dropResumeTab(last.name);
    flashStatus("previous session is gone — opening fresh");
  }
  openTab(last.name, { command, cwd: last.cwd });
}

// Open a new tmux session at the active tab's cwd (cmd/ctrl+T). The session is
// named after that directory; falls back to a plain "shell" at HOME when there's
// no active terminal to read a cwd from.
export function openTabAtPwd() {
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
