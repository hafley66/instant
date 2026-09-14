// Pure row model for the Boop Search grid: hits from `boop_search` become
// either flat hit rows or chat rows carrying their hits as children.
export type BoopSearchHit = {
  session: string;
  harness: string;
  cwd?: string | null;
  nickname?: string | null;
  turn: number;
  ts: number;
  role: string;
  snippet: string;
  said: string;
  sessionLastTs: number;
  sessionTurns: number;
};

export type BoopSearchStatus = {
  indexedTurns: number;
  sessionsDone: number;
  sessionsTotal: number;
  building: boolean;
  error?: string | null;
  updatedMs: number;
};

export type SearchRole = "all" | "user" | "assistant";

export type SearchRow = {
  id: string;
  kind: "chat" | "hit";
  name: string;
  chat: string;
  session: string;
  harness: string;
  cwd: string;
  role: string;
  ts: number;
  lastTs: number;
  turn: number;
  snippet: string;
  count: number;
  hit?: BoopSearchHit;
  children?: SearchRow[];
};

export function chatLabel(hit: Pick<BoopSearchHit, "nickname" | "cwd" | "session">): string {
  if (hit.nickname) return hit.nickname;
  if (hit.cwd) return hit.cwd.replace(/\/+$/, "").split("/").pop() || hit.cwd;
  return hit.session.slice(0, 8);
}

function hitRow(hit: BoopSearchHit): SearchRow {
  const chat = chatLabel(hit);
  return {
    id: `hit:${hit.session}:${hit.turn}`,
    kind: "hit",
    name: chat,
    chat,
    session: hit.session,
    harness: hit.harness,
    cwd: hit.cwd ?? "",
    role: hit.role,
    ts: hit.ts,
    lastTs: hit.sessionLastTs,
    turn: hit.turn,
    snippet: hit.snippet,
    count: 1,
    hit,
  };
}

/// Flat: one row per hit. Tree: one row per chat, hits underneath, chat rows
/// ordered by last activity and hits by turn time, both newest first.
export function searchRows(hits: BoopSearchHit[], tree: boolean): SearchRow[] {
  if (!tree) return hits.map(hitRow);
  const chats = new Map<string, SearchRow>();
  for (const hit of hits) {
    const row = hitRow(hit);
    const chat = chats.get(hit.session);
    if (chat) {
      chat.children!.push(row);
      chat.count += 1;
      chat.ts = Math.max(chat.ts, hit.ts);
      continue;
    }
    chats.set(hit.session, {
      ...row,
      id: `chat:${hit.session}`,
      kind: "chat",
      snippet: "",
      hit: undefined,
      children: [row],
    });
  }
  const rows = [...chats.values()];
  for (const chat of rows) chat.children!.sort((a, b) => b.ts - a.ts);
  rows.sort((a, b) => b.lastTs - a.lastTs);
  return rows;
}

export function whenLabel(ts: number, now = Date.now()): string {
  if (!ts) return "";
  const age = now - ts;
  if (age < 0) return new Date(ts).toLocaleString();
  const minutes = Math.floor(age / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(ts).toISOString().slice(0, 10);
}
