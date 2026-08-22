// Favorited AI turns (ledger.rs reads, favorites.db persists) + the on-screen
// turn identification that backs the terminal right-click "favorite this turn"
// gesture. Also the per-tab ledger cache warmed on tab activation, the harness
// session resolver, and the ★ rail badge.
import { invoke } from "./generated/native";
import { store, type AiMessage, type Fav } from "./state";
import { addPreviewPanel } from "./reactdock";
import { registerPlugin } from "./plugin";
import { FavoritesPanelV2, setFavoritesPanel, type FavTreeRow } from "./tablepanels";
import { escapeHtml, baseName, flashStatus } from "./core";
import { previewInsts } from "./preview";
import { tabs, tabMetaById, tabCwds } from "./terminal";
import { openWorktree, resumeLaunch, sessionsForWorktree } from "./worktrees";
import { harnessAdapter, harnessesForCommand, type HarnessId } from "./harness";
import { boundSessionFirst, type ResolvedSession } from "./0a_terminalSessionCandidates";
import type { BoopTurn } from "./0_terminalTurnVisibility";
import type { BoopFavorite } from "./00a_terminalIntersection";
import { settings } from "./0_settings";

// cwd keys the harness session lookup and the claude ledger path; the launch
// command's first token hints the agent (but we don't require it — a folder can
// have a claude/opencode session even if the tab is a plain shell the user ran
// the agent inside).
export type { ResolvedSession } from "./0a_terminalSessionCandidates";

// Resolve harness sessions for a tab by probing BOTH editors' on-disk stores
// (harness_session) across EVERY candidate cwd — claude keys its jsonl dir by the
// launch cwd, but the live tmux pane may have cd'd into a subdir, so paths[0]
// alone misses it. We try each candidate (live pane cwds, then the launch cwd)
// and carry the cwd that resolved, because the ledger read needs it. The launch
// command, when it names an agent, just orders the probe so the declared agent
// wins ties.
// harness_session stats every transcript under the cwd's project dir (1232
// files for sprefa, measured 2026-08-22) and ran on every turn-visibility scan
// with no cache. Hold each (editor, cwd) answer briefly; in-flight reads dedupe.
const RESOLVE_TTL_MS = 5_000;
const resolveCache = new Map<string, { readAt: number; sid: string | null }>();
const resolveReads = new Map<string, Promise<string | null>>();
async function resolveCached(editor: HarnessId, cwd: string): Promise<string | null> {
  const key = `${editor}:${cwd}`;
  const hit = resolveCache.get(key);
  if (hit && performance.now() - hit.readAt < RESOLVE_TTL_MS) return hit.sid;
  const active = resolveReads.get(key);
  if (active) return active;
  const read = harnessAdapter(editor).resolve(cwd)
    .catch(() => null)
    .then((sid) => {
      resolveCache.set(key, { readAt: performance.now(), sid });
      return sid;
    })
    .finally(() => resolveReads.delete(key));
  resolveReads.set(key, read);
  return read;
}

export async function tabSessions(
  cwds: string[],
  command: string | null,
  liveHarness: HarnessId | null = null,
): Promise<ResolvedSession[]> {
  const fallback = harnessesForCommand(command);
  const order: HarnessId[] = liveHarness
    ? [liveHarness, ...fallback.filter((editor) => editor !== liveHarness)]
    : fallback;
  const out: ResolvedSession[] = [];
  const seen = new Set<string>();
  for (const cwd of cwds) {
    for (const editor of order) {
      const sid = await resolveCached(editor, cwd);
      const key = sid ? `${editor}:${sid}` : "";
      if (sid && !seen.has(key)) {
        seen.add(key);
        out.push({ editor, sessionId: sid, cwd });
      }
    }
  }
  return out;
}

async function sessionsForTab(id: string): Promise<ResolvedSession[]> {
  const meta = tabMetaById(id);
  const tab = tabs.get(id);
  if (!meta || !tab) return [];
  const cwds = tabCwds(id);
  const sessions = await tabSessions(cwds, meta.command, meta.harness);
  return boundSessionFirst(sessions, cwds, settings.resumeTabs.$()[tab.name]);
}

// Newest agent session in a cwd whose id is NOT already claimed by another tab's
// resume record. Several agents can share a cwd, so "latest in cwd" alone hands
// every same-cwd tab the same id; skipping claimed ids gives each closed tab a
// distinct session to resume. Probes both editors (declared agent first), each
// newest-first, and returns the first unclaimed hit.
export async function unclaimedSession(
  meta: { cwd: string; command: string | null; harness?: HarnessId | null },
  claimed: Set<string>,
): Promise<{ editor: HarnessId; sessionId: string } | null> {
  const fallback = harnessesForCommand(meta.command);
  const order: HarnessId[] = meta.harness
    ? [meta.harness, ...fallback.filter((editor) => editor !== meta.harness)]
    : fallback;
  for (const editor of order) {
    const ids = await harnessAdapter(editor).sessions(meta.cwd).catch(() => [] as string[]);
    for (const sid of ids) if (!claimed.has(sid)) return { editor, sessionId: sid };
  }
  return null;
}

// Per-(editor,session) ledger cache + the per-tab merged turn list the terminal
// right-click matches against. Warmed on tab activation so the context menu can
// stay synchronous.
const ledgerCache = new Map<string, AiMessage[]>();
export const tabTurns = new Map<string, AiMessage[]>();
const boopTurnCache = new Map<string, { readAt: number; turns: BoopTurn[] }>();
const boopTurnReads = new Map<string, Promise<BoopTurn[]>>();
const boopCandidateCache = new Map<string, { readAt: number; turns: BoopTurn[] }>();
const boopCandidateReads = new Map<string, Promise<BoopTurn[]>>();
export let boopFavorites: BoopFavorite[] = [];
// Where each session's ledger actually lives (the cwd that resolved it), keyed by
// `editor:session_id`. fav_add needs this cwd so a favorite resumes in the right
// folder — paths[0] (tabMetaById) can be a subdir the session wasn't keyed under.
export const turnCwd = new Map<string, string>();

export async function boopTurnsForSession(session: string): Promise<BoopTurn[]> {
  const cached = boopTurnCache.get(session);
  if (cached && performance.now() - cached.readAt < 1000) return cached.turns;
  const active = boopTurnReads.get(session);
  if (active) return active;
  const read = invoke<BoopTurn[]>("boop_turns", { session })
    .catch(() => [] as BoopTurn[])
    .then((turns) => {
      boopTurnCache.set(session, { readAt: performance.now(), turns });
      return turns;
    })
    .finally(() => boopTurnReads.delete(session));
  boopTurnReads.set(session, read);
  return read;
}

export async function boopTurnsForTab(id: string): Promise<BoopTurn[]> {
  const sessions = await sessionsForTab(id);
  const batches = await Promise.all(sessions.map(({ sessionId }) => boopTurnsForSession(sessionId)));
  const unique = new Map<string, BoopTurn>();
  for (const turn of batches.flat()) unique.set(`${turn.session}:${turn.turn}`, turn);
  return [...unique.values()].sort((left, right) => left.ts - right.ts || left.turn - right.turn);
}

export async function boopCandidateTurns(harness: HarnessId): Promise<BoopTurn[]> {
  const cached = boopCandidateCache.get(harness);
  if (cached && performance.now() - cached.readAt < 10_000) return cached.turns;
  const active = boopCandidateReads.get(harness);
  if (active) return active;
  const read = invoke<BoopTurn[]>("boop_turns_recent", {
    since: Date.now() - 15 * 60 * 1000,
    harness,
  }).then(async (recent) => {
    const sessions = [...new Set(recent.map((turn) => turn.session))];
    const turns = (await Promise.all(sessions.map(boopTurnsForSession))).flat();
    boopCandidateCache.set(harness, { readAt: performance.now(), turns });
    return turns;
  }).catch(() => [] as BoopTurn[]).finally(() => boopCandidateReads.delete(harness));
  boopCandidateReads.set(harness, read);
  return read;
}

export async function favoriteBoopTurn(turn: BoopTurn): Promise<void> {
  const wasFavorite = isBoopTurnFav(turn);
  await invoke<BoopFavorite[]>("boop_favorite_toggle", { turn }).then((favorites) => {
    boopFavorites = favorites;
    store.set({ aiFavs: [...store.get().aiFavs] });
    flashStatus(wasFavorite ? "unfavorited Boop turn" : `★ favorited ${turn.role} turn ${turn.turn}`);
  }, (error) => console.error("boop_favorite_toggle", error));
}

export function isBoopTurnFav(turn: Pick<BoopTurn, "session" | "turn">): boolean {
  return boopFavorites.some((favorite) => favorite.source === `turn:${turn.session}:${turn.turn}`);
}
async function turnsFor(
  editor: HarnessId,
  sessionId: string,
  cwd: string,
): Promise<AiMessage[]> {
  const key = `${editor}:${sessionId}:${cwd}`;
  const hit = ledgerCache.get(key);
  if (hit) return hit;
  const msgs = await harnessAdapter(editor).read(sessionId, cwd).catch(() => [] as AiMessage[]);
  ledgerCache.set(key, msgs);
  return msgs;
}
// Load (or refresh) the turns behind a terminal tab into tabTurns. Re-reads the
// latest session each call (drops the cache for it) so a live conversation's new
// turns become matchable.
export async function warmTurns(id: string) {
  const sessions = await sessionsForTab(id);
  for (const s of sessions) {
    ledgerCache.delete(`${s.editor}:${s.sessionId}:${s.cwd}`); // pick up new turns
    turnCwd.set(`${s.editor}:${s.sessionId}`, s.cwd);
    const turns = await turnsFor(s.editor, s.sessionId, s.cwd);
    if (turns.length) {
      tabTurns.set(id, turns);
      return;
    }
  }
  tabTurns.set(id, []);
}

// Live sidebar polling reads only records after each harness's monotonic seq.
// Claude/Codex use ledger line sequence; OpenCode uses time_created, all behind
// the same HarnessAdapter.read(session, cwd, afterSeq) interface.
export async function refreshTurns(id: string): Promise<AiMessage[] | null> {
  const sessions = await sessionsForTab(id);
  if (!sessions.length) return null;
  for (const s of sessions) {
    const key = `${s.editor}:${s.sessionId}:${s.cwd}`;
    turnCwd.set(key, s.cwd);
    const prior = ledgerCache.get(key) ?? [];
    const afterSeq = prior.reduce((latest, turn) => Math.max(latest, turn.seq), 0);
    const fresh = await harnessAdapter(s.editor).read(s.sessionId, s.cwd, afterSeq).catch(() => [] as AiMessage[]);
    const merged = [...prior, ...fresh.filter((turn) => !prior.some((old) => old.id === turn.id))];
    ledgerCache.set(key, merged);
    if (merged.length) {
      tabTurns.set(id, merged);
      return merged;
    }
  }
  tabTurns.set(id, []);
  return [];
}

// Is this turn already in favorites? (identity = editor + session + message id)
export function isTurnFav(turn: AiMessage): boolean {
  return store.get().aiFavs.some(
    (f) =>
      f.editor === turn.editor &&
      f.session_id === turn.session_id &&
      f.message_id === turn.id,
  );
}

// Snapshot one identified turn into favorites.db. No navigation — the toast
// confirms and the ★ rail badge ticks up; open the panel yourself when you want.
export async function favoriteTurn(turn: AiMessage, cwd: string) {
  const favs = await invoke<Fav[]>("fav_add", { msg: turn, cwd }).catch((e) => {
    console.error("fav_add", e);
    return null;
  });
  if (favs) {
    store.set({ aiFavs: favs });
    flashStatus(`★ favorited ${turn.role} turn`);
  }
}

export async function unfavoriteTurn(turn: AiMessage) {
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

// Open one ledger turn as a viewable record (the "jsonl item") in a split-right
// preview tab, keyed by turn identity. Same preview machinery as locateFav; we
// render the parsed record so the on-disk jsonl line is viewable without a
// (multi-MB) raw re-read. The locator carries its on-disk address.
export function openTurn(turn: AiMessage) {
  const key = `turn:${turn.editor}:${turn.session_id}:${turn.id}`;
  let inst = previewInsts.get(key);
  if (!inst) {
    const el = document.createElement("div");
    el.className = "fs-preview";
    inst = { el };
    previewInsts.set(key, inst);
  }
  const title = `${turn.role} · ${turn.editor}`;
  inst.el.innerHTML =
    `<div class="fs-preview-meta">${escapeHtml(title)}<br><span>${escapeHtml(turn.locator)}</span></div>` +
    `<pre class="code-plain">${escapeHtml(JSON.stringify(turn, null, 2))}</pre>`;
  addPreviewPanel(key, title, inst.el, "right");
}

// cmd+shift+s: favorite the active tab's latest turn (no pointer needed). Probes
// the cwd for a session, so it works even when the tab is a plain shell.
export async function favoriteCurrentTurn() {
  const id = settings.active.$();
  const meta = id ? tabMetaById(id) : null;
  if (!id || !meta) {
    flashStatus("no folder for this tab");
    return;
  }
  const sessions = await tabSessions(tabCwds(id), meta.command, meta.harness);
  if (!sessions.length) {
    flashStatus("no AI session for this folder");
    return;
  }
  const s = sessions[0];
  const msg = await harnessAdapter(s.editor).latest(s.sessionId, s.cwd).catch(() => null);
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
  const boopGroups = new Map<string, BoopFavorite[]>();
  for (const favorite of boopFavorites) {
    const session = favorite.source.match(/^turn:(.*):\d+$/)?.[1] ?? "unknown";
    const list = boopGroups.get(session);
    if (list) list.push(favorite);
    else boopGroups.set(session, [favorite]);
  }
  for (const [session, list] of boopGroups) {
    rows.push({
      id: `boop:${session}`,
      kind: "session",
      editor: "boop",
      label: session,
      starredAt: Math.max(...list.map((favorite) => favorite.created_ts * 1000)),
      sessionId: session,
      count: list.length,
      children: list.map((favorite) => ({
        id: `boop-favorite:${favorite.favorite_id}`,
        kind: "turn" as const,
        editor: "boop" as const,
        label: favorite.source,
        starredAt: favorite.created_ts * 1000,
        role: "turn",
        preview: favorite.body.replace(/\s+/g, " ").slice(0, 120),
        boopFav: favorite,
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
  if (r.kind !== "session" || r.editor === "boop" || !r.cwd || !r.sessionId) return;
  openWorktree(r.cwd, "", r.cwd, resumeLaunch(r.editor, r.sessionId), true);
}

// Panel def + data bridge in one place, so the "favorites" plugin's whole
// registration is a single call from main()'s init list. Called from inside
// registerBuiltin() (panels.ts) at the exact point the panel def used to sit
// in that plugin's array, so rail order is unchanged.
export function registerFavoritesPlugin() {
  registerPlugin({
    id: "favorites",
    panels: [
      {
        id: "favorites",
        title: "Favorites",
        icon: "★",
        iconLabel: "Favorites",
        html: "",
        component: FavoritesPanelV2,
        onShow: () => refreshFavorites(),
      },
    ],
  });
  setFavoritesPanel({
    rows: favTreeRows,
    onShow: () => refreshFavorites(),
    expanded: () => Object.fromEntries(settings.favExpanded.$().map((k) => [k, true])),
    setExpanded: (e) => {
      const keys = e === true ? [] : Object.keys(e).filter((k) => (e as Record<string, boolean>)[k]);
      settings.favExpanded.$(keys);
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
    removeBoop: (favorite) => {
      const match = favorite.source.match(/^turn:(.*):(\d+)$/);
      if (!match) return;
      const turn = boopTurnCache.get(match[1])?.turns.find((candidate) => candidate.turn === Number(match[2]));
      if (!turn) return;
      void favoriteBoopTurn(turn);
    },
  });
}

export function refreshFavorites() {
  Promise.all([invoke<Fav[]>("fav_list"), invoke<BoopFavorite[]>("boop_favorites")])
    .then(([favs, favorites]) => {
      boopFavorites = favorites;
      store.set({ aiFavs: favs });
    })
    .catch(() => {});
}

// Passive count badge on the ★ favorites rail button, so a saved turn registers
// in the UI without navigating there. Subscribed to aiFavs.
export function updateFavBadge() {
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
