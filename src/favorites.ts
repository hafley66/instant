// Favorited AI turns (ledger.rs reads, favorites.db persists) + the on-screen
// turn identification that backs the terminal right-click "favorite this turn"
// gesture. Also the per-tab ledger cache warmed on tab activation, the harness
// session resolver, and the ★ rail badge.
import { invoke } from "@tauri-apps/api/core";
import { store, type AiMessage, type Fav } from "./state";
import { addPreviewPanel } from "./reactdock";
import { setFavoritesPanel, type FavTreeRow } from "./tablepanels";
import { escapeHtml, baseName, flashStatus } from "./core";
import { previewInsts } from "./preview";
import { tabs, tabMetaById, tabCwds } from "./terminal";
import { openWorktree, resumeLaunch, sessionsForWorktree } from "./worktrees";

// cwd keys the harness session lookup and the claude ledger path; the launch
// command's first token hints the agent (but we don't require it — a folder can
// have a claude/opencode session even if the tab is a plain shell the user ran
// the agent inside).
export type ResolvedSession = { editor: "claude" | "opencode"; sessionId: string; cwd: string };

// Resolve harness sessions for a tab by probing BOTH editors' on-disk stores
// (harness_session) across EVERY candidate cwd — claude keys its jsonl dir by the
// launch cwd, but the live tmux pane may have cd'd into a subdir, so paths[0]
// alone misses it. We try each candidate (live pane cwds, then the launch cwd)
// and carry the cwd that resolved, because the ledger read needs it. The launch
// command, when it names an agent, just orders the probe so the declared agent
// wins ties.
export async function tabSessions(cwds: string[], command: string | null): Promise<ResolvedSession[]> {
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
export async function unclaimedSession(
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
export const tabTurns = new Map<string, AiMessage[]>();
// Where each session's ledger actually lives (the cwd that resolved it), keyed by
// `editor:session_id`. fav_add needs this cwd so a favorite resumes in the right
// folder — paths[0] (tabMetaById) can be a subdir the session wasn't keyed under.
export const turnCwd = new Map<string, string>();
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
export async function warmTurns(id: string) {
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

// --- on-screen turn identification (the alt-screen blocks text selection, so we
// read the xterm buffer directly). Each harness marks turn boundaries visually:
// claude prefixes assistant turns with a ⏺ bullet; opencode paints message blocks
// with a non-default background. We find the block under the pointer via those
// signatures, then match its rendered text to a ledger turn. ---
// Turn-boundary glyphs: claude's ⏺ assistant bullet + the › chevron on human
// turns; opencode delimits with a non-default bg run instead.
const TURN_BULLETS = new Set(["⏺", "●", "◉", "⏵", "•", "◆", "›", "❯", "»", "▶", "🭬"]);

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

const normText = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

// The search query for a right-click: the live selection if there is one, else
// the rendered block under the pointer (surrounding lines, signature-bounded).
export function ledgerQuery(id: string, clientY: number): string {
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
export function searchTurns(turns: AiMessage[], query: string, limit = 6): AiMessage[] {
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

// cmd+shift+s: favorite the active tab's latest turn (no pointer needed). Probes
// the cwd for a session, so it works even when the tab is a plain shell.
export async function favoriteCurrentTurn() {
  const id = store.get().active;
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

export function registerFavoritesBridge() {
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

export function refreshFavorites() {
  invoke<Fav[]>("fav_list")
    .then((favs) => store.set({ aiFavs: favs }))
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
