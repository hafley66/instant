// tmux sessions + git worktree discovery/tree UI + spaces (non-git folders) +
// the filesystem browser nested under worktree leaves. Owns the session list,
// the worktree scan (ghcacher SSE or local git), the resume-id bookkeeping, the
// v2 react-table panel bridges, and the legacy v1 tree/table renderers.
// todo(split): extract tmux session discovery and worktree association into a sibling module
// todo(split): extract filesystem tree loading and actions into a sibling module
// todo(migration): remove legacy v1 worktree renderers (depends: TreeTable parity for every worktree action)
// todo(test): cover Worktrees panel refresh plus SSE reconnect as an integration flow
import { invoke } from "./generated/native";
import {
  store,
  type WorktreeRow,
  type RogueSession,
  type WtAgent,
  type FsEntry,
  type DirListing,
} from "./state";
import {
  setTmuxPanel,
  setWorktreesPanel,
  type TmuxRow,
  type RogueRow,
  type WtTreeRow,
} from "./tablepanels";
import { showContextMenu, type CtxItem } from "./ctxmenu";
import { renderTable, type SortState } from "./table";
import {
  $,
  baseName,
  tmuxName,
  tildify,
  flashStatus,
  sessionId,
  activeId,
  fileGlyph,
  pathArg,
  showError,
} from "./core";
import { openDiffPanel, openPreviewPanel } from "./preview";
import { tabs, openTab, closeTab, settleClosures, pasteToActive } from "./terminal";
import {
  applyWorktreeDeltaRows,
  queryWorktreeSnapshot,
  type WorktreeDelta,
} from "./ghcacheSnapshot";
import { paths as apiPaths } from "./generated/api";

export type Session = {
  name: string;
  windows: number;
  attached: boolean;
  activity: number; // unix seconds of last activity (tmux #{session_activity})
  created: number; // unix seconds the session was created
  paths: string[]; // distinct pane cwds; mapped to worktrees in refreshSessions
  commands: string[]; // distinct foreground process per pane (claude, nvim, zsh…)
};

export function renderSessionActive() {
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

// Scanned rows ++ rows auto-discovered for a live session's cwd (see
// autoTrackSessionPaths) — every read site that maps a cwd to "its worktree"
// (chips, the worktree tree, adopt) should see both, not just the last scan.
// Scanned wins on a path collision (it's the fresher, full-walk copy).
function allWorktreeRows(): WorktreeRow[] {
  const scanned = store.get().worktrees;
  const known = new Set(scanned.map((w) => w.worktree));
  return [...scanned, ...store.get().autoWorktrees.filter((w) => !known.has(w.worktree))];
}

// cwds already probed via worktree_at this run (hit or miss) — git calls are
// cheap but pointless to repeat every refreshSessions tick for a path that
// already came back "not a git worktree" (a plain shell, /tmp, $HOME, …).
const wtProbed = new Set<string>();

// A live session sitting in a cwd that isn't in the scanned worktree list — a
// shell opened bare and cd'd by hand, then an agent typed into it — has no
// worktree row, so it gets no chip and no resume affordances in the worktree
// tree. Resolve it directly via git (worktree_at) and fold it into
// autoWorktrees so it slots into the tree like any scanned worktree. No-op
// (and cached) once a path has been probed or is already known.
async function autoTrackSessionPaths(paths: string[]) {
  const rows = allWorktreeRows();
  for (const cwd of paths) {
    if (wtProbed.has(cwd) || worktreesForPaths([cwd], rows).length) continue;
    wtProbed.add(cwd);
    const found = await invoke<WorktreeRow | null>("worktree_at", { path: cwd }).catch(() => null);
    if (found && !allWorktreeRows().some((w) => w.worktree === found.worktree)) {
      store.set({ autoWorktrees: [...store.get().autoWorktrees, found] });
    }
  }
}

// Drop auto-discovered rows a real scan now covers, so a later rescan doesn't
// leave a stale duplicate sitting in autoWorktrees once the path is properly
// scanned (its branch/dirty would also go stale without this).
function pruneAutoWorktrees(scanned: WorktreeRow[]) {
  const found = new Set(scanned.map((w) => w.worktree));
  const cur = store.get().autoWorktrees;
  if (cur.some((w) => found.has(w.worktree))) {
    store.set({ autoWorktrees: cur.filter((w) => !found.has(w.worktree)) });
  }
}

// The sidebar SESSIONS list mirrors the live tmux sessions (the real running
// shells/agents), not a creator. Order the launcher rows per store.sessionSort.
// Name is the stable tiebreak.
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
    else if (key === "proc")
      c = foregroundProc(a.commands ?? []).localeCompare(foregroundProc(b.commands ?? []));
    else if (key === "pwd") c = (a.paths?.[0] ?? "").localeCompare(b.paths?.[0] ?? "");
    else if (key === "chips")
      c =
        (store.get().sessionWorktrees[a.name]?.length ?? 0) -
        (store.get().sessionWorktrees[b.name]?.length ?? 0);
    else c = a.activity - b.activity;
    return c !== 0 ? c * sign : a.name.localeCompare(b.name, undefined, { numeric: true });
  });
}

// Shells aren't interesting as a "what's running here" label; surface the agent
// or tool instead. Returns the first non-shell foreground command, else "".
const SHELLS = new Set(["zsh", "bash", "fish", "sh", "tmux", "-zsh", "-bash"]);
export function foregroundProc(commands: string[]): string {
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
export const looksLikeAgentProc = (p: string) =>
  AGENT_PROCS.has(p) || /^\d+\.\d+/.test(p) || p.includes("opencode");
const isPinnedSession = (name: string) => store.get().pinnedSessions.includes(name);
function togglePinSession(name: string) {
  const cur = store.get().pinnedSessions;
  store.set({
    pinnedSessions: cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name],
  });
  refreshSessions();
}

export async function refreshSessions() {
  let live: Session[] = [];
  try {
    live = await invoke<Session[]>("list_sessions");
  } catch (e) {
    console.error(e);
  }

  // Relate sessions to worktrees and accumulate the touched set (persisted).
  // Pure data; runs even when the panel is closed.
  const rows = allWorktreeRows();
  const sw = { ...store.get().sessionWorktrees };
  for (const s of live) {
    const matched = worktreesForPaths(s.paths ?? [], rows);
    if (matched.length) sw[s.name] = [...new Set([...(sw[s.name] ?? []), ...matched])];
    else autoTrackSessionPaths(s.paths ?? []); // fire-and-forget; store update re-renders when it lands
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

// claude/opencode running on a real terminal outside any tmux session — typed
// straight into Terminal.app/iTerm instead of opened through instant. Polled
// so the tmux panel can flag "you've gone rogue" without the user having to
// notice on their own.
export async function refreshRogue() {
  let rogue: RogueSession[] = [];
  try {
    rogue = await invoke<RogueSession[]>("rogue_agent_sessions");
  } catch (e) {
    console.error(e);
  }
  store.set({ rogueSessions: rogue });
}

// Pull a rogue process's cwd into a tracked tmux session: resolve it to the
// worktree it sits in (if any), then open it like any other worktree launch.
// If the harness has an on-disk conversation for that cwd already (the rogue
// process's own history), resume it instead of starting blank. This doesn't
// touch the rogue process itself — there's no portable way to reparent a tty
// into tmux — so the old terminal window is left for the user to close.
async function adoptRogue(r: RogueSession) {
  const cwd = r.cwd;
  if (!cwd) {
    flashStatus("no cwd for this process");
    return;
  }
  const rows = store.get().worktrees;
  const matched = rows.find((w) => cwd === w.worktree || cwd.startsWith(w.worktree + "/"));
  const wtPath = matched?.worktree ?? cwd;
  const clone = matched?.clone ?? wtPath;
  const branch = matched?.branch ?? "";
  const tool = r.command as "claude" | "opencode";
  const sid = await invoke<string | null>("harness_session", { tool, cwd: wtPath }).catch(() => null);
  const cmd = sid ? resumeLaunch(tool, sid) : r.command;
  await openWorktree(clone, branch, wtPath, cmd, true);
  flashStatus(`adopted ${r.command} · pid ${r.pid} — close the old terminal window`);
}

// ---- worktrees table: discover existing worktrees across N repo clones ----
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
export async function openWorktree(clone: string, branch: string, wtPath: string, command?: string, fresh = false) {
  const name = fresh ? freshSessionName(clone, branch) : baseSessionName(clone, branch);
  // Wait for any in-flight close teardown on this name BEFORE reading
  // resumeTabs or recreating the session: exitOrDetachTab writes the resume
  // record (its on-disk session probe) and kills the tmux session both async,
  // on closeChain. Reading resumeTabs first (the old order) could see the
  // pre-close value and silently fall through to newAgentLaunch — a brand new
  // conversation, the previous one lost outright — on a close/reopen fast
  // enough to race it. Not needed for a fresh name (no prior session to race).
  if (!fresh) await settleClosures();
  const known = store.get().resumeTabs[name];
  const live = !fresh && !!known && (await resumeIdIsLive(known!.editor, wtPath, known!.sessionId));
  if (known && !fresh && !live) {
    console.warn("[resume]", name, "dead id", known.sessionId.slice(0, 8), "— dropping");
    dropResumeTab(name);
    flashStatus("previous session is gone — opening fresh");
  }
  const cmd = live ? resumeLaunch(known!.editor, known!.sessionId) : newAgentLaunch(name, command);
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
export const KNOWN_RESUME: Record<string, string> = {
  claude: "--resume",
  opencode: "--session",
};

// Relaunch command for a previously-exited agent tab: "claude --resume <id>" /
// "opencode --session <id>".
export const resumeLaunch = (editor: "claude" | "opencode", sessionId: string) =>
  `${editor} ${KNOWN_RESUME[editor]} ${sessionId}`;

// resumeTabs can hold a sessionId that no longer resolves to anything on disk
// (before the close/reopen races elsewhere in this file were fixed, a wrong
// id could get recorded outright). Resuming a dead id isn't a soft failure:
// the harness exits immediately and the tab shows a flash of "loading" then
// exit, no diagnostic anywhere a user would think to look. Verify against the
// on-disk session list before trusting it.
//
// Tried falling back to the newest on-disk session in the same cwd when the
// exact id didn't match, on the theory that the harness rotates ids on its
// own resume. Wrong, and actively dangerous: a cwd can have several genuinely
// distinct concurrent sessions (the whole reason exitOrDetachTab's `claimed`
// set exists — see "rando old session"), so "newest in this cwd" is not "this
// tab's session". It silently swapped in an unrelated conversation. An exact
// id either matches or it doesn't; there is no safe guess in between.
export async function resumeIdIsLive(
  editor: "claude" | "opencode",
  cwd: string,
  sessionId: string,
): Promise<boolean> {
  const ids = await invoke<string[]>("harness_sessions", { tool: editor, cwd }).catch(() => [] as string[]);
  return ids.includes(sessionId);
}

// Drop a dead resumeTabs record so future opens stop retrying it.
export function dropResumeTab(name: string) {
  const rest = { ...store.get().resumeTabs };
  delete rest[name];
  store.set({ resumeTabs: rest });
}

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
  const wts = allWorktreeRows();
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
function tmuxRows(): TmuxRow[] {
  const rows = allWorktreeRows();
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

function rogueRows(): RogueRow[] {
  return store.get().rogueSessions.map((r) => ({
    pid: r.pid,
    tty: r.tty,
    command: r.command,
    cwd: r.cwd ? tildify(r.cwd) : r.args,
  }));
}

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
  const rows = allWorktreeRows();
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

export function registerV2Bridges() {
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
    rogue: rogueRows,
    onAdopt: (r) => {
      const found = store.get().rogueSessions.find((s) => s.pid === r.pid);
      if (found) adoptRogue(found);
    },
  });
  setWorktreesPanel({
    treeRows: wtTreeRows,
    onShow: () => scanWorktreesIfNeeded(),
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
export function sessionsForWorktree(wtPath: string): Session[] {
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

export function renderWorktreesPanel() {
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

// Worktree data comes from the ghcacher daemon (HTTP snapshot + SSE push on
// 127.0.0.1:7748) when it's running, else falls back to the local Rust git scan.
// The daemon runs a bounded, debounced background sweep, so neither path forks
// hundreds of `git status` on the UI's hot path.
let wtScanning = false; // in-flight guard: stops overlapping scans stacking
let wtScanned = false; // one scan has completed (any source) -> stop auto-refire
let wtSse: EventSource | null = null;

// Called from panel onShow paths: scan once, then stop auto-firing on every show.
export function scanWorktreesIfNeeded() {
  if (!wtScanned) scanWorktrees();
}

// Apply one SSE change_log frame to the worktrees store, keyed by worktree path.
function applyWorktreeDelta(msg: WorktreeDelta) {
  store.set({ worktrees: applyWorktreeDeltaRows(store.get().worktrees, msg) });
}

// Subscribe to ghcacher's SSE stream once; filter to worktree deltas. The browser
// EventSource auto-reconnects; on a hard error we drop it so the next scan re-subs.
function subscribeWorktrees() {
  if (wtSse) return;
  try {
    const es = apiPaths.events.connect();
    wtSse = es;
    es.onmessage = (ev) => {
      let msg: { entity_type?: string; event: string; payload: WorktreeRow | { worktree: string } };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.entity_type !== "worktree") return;
      applyWorktreeDelta(msg);
    };
    es.onerror = () => {
      es.close();
      if (wtSse === es) wtSse = null;
    };
  } catch {
    wtSse = null;
  }
}

export async function scanWorktrees() {
  if (wtScanning) return; // never stack scans (the old volley)
  wtScanning = true;
  try {
    const root = store.get().scanRoot.trim();
    const snapshot = await queryWorktreeSnapshot(() =>
        invoke<WorktreeRow[]>("scan_worktrees", {
          roots: root ? [root] : [],
          maxDepth: null,
        }),
    );
    store.set({ worktrees: snapshot.rows });
    pruneAutoWorktrees(snapshot.rows);
    if (snapshot.source === "ghcache") {
      subscribeWorktrees();
    }
    wtScanned = true;
  } catch (e) {
    console.error("scan_worktrees:", e);
    wtScanned = true; // a failed scan still counts: don't auto-refire on every show
  } finally {
    wtScanning = false;
  }
}

// ---- files: lazy directory listing + activity logging ----
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
