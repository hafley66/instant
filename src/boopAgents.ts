// Data source for the Agents (boop) panel. Shells out to the boop binary
// exclusively (no scripts/bus.ts, no raw tmux) and parses its text/TSV/ndjson
// output into plain row objects. Parsers are pure and fixture-tested; the
// client takes an injected runner so the tauri boundary stays out of this file.
export const BOOP_BIN: string =
  "/Users/chrishafley/projects/sprefa/.boop-worktrees/lane/boop-rows/v6/boop/target/release/boop";

export interface LaneInfo {
  state: string; // live | dead | ?
  lane: string;
  harness: string;
  mode: string;
  model: string;
  tmux: string;
  cwd: string;
}

export function parseLaneList(text: string): LaneInfo[] {
  const out: LaneInfo[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const p = line.split(/\s+/);
    if (p.length < 6) continue;
    out.push({
      state: p[0],
      lane: p[1],
      harness: p[2],
      mode: p[3],
      model: p[4],
      tmux: p[5],
      cwd: p.slice(6).join(" "),
    });
  }
  return out;
}

export interface PsInfo {
  pid: number | null;
  rssKb: number | null;
  cpuPct: number | null;
  uptimeSec: number | null;
  children: number | null;
}

export function parsePs(text: string): Record<string, PsInfo> {
  const out: Record<string, PsInfo> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("lane\t")) continue;
    const p = line.split("\t");
    if (p.length < 6) continue;
    const num = (s: string): number | null => {
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    };
    out[p[0]] = {
      pid: num(p[1]),
      rssKb: num(p[2]),
      cpuPct: num(p[3]),
      uptimeSec: num(p[4]),
      children: num(p[5]),
    };
  }
  return out;
}

export interface BoopSession {
  session: string;
  nickname: string;
  harness: string;
  cwd: string;
  turns: number;
  startedTs: number;
  lastTs: number;
}

export function parseSessions(text: string): BoopSession[] {
  const out: BoopSession[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      out.push({
        session: String(o.session ?? ""),
        nickname: String(o.nickname ?? ""),
        harness: String(o.harness ?? ""),
        cwd: String(o.cwd ?? ""),
        turns: Number(o.turns ?? 0),
        startedTs: Number(o.started_ts ?? 0),
        lastTs: Number(o.last_ts ?? 0),
      });
    } catch {
      // skip non-json line
    }
  }
  return out;
}

export interface LaneDetail {
  lane: string | null;
  state: string | null;
  harness: string | null;
  tmux: string | null;
  cwd: string | null;
  model: string | null;
  mode: string | null;
  sessionId: string | null;
  routeText: string | null;
}

export function parseLaneGet(text: string): Partial<LaneDetail> {
  try {
    const o = JSON.parse(text);
    return {
      lane: o.lane ?? null,
      state: o.state ?? null,
      harness: o.harness ?? null,
      tmux: o.tmux ?? null,
      cwd: o.cwd ?? null,
      model: o.model ?? null,
      mode: o.mode ?? null,
      sessionId: o.session_id ?? null,
      routeText: null,
    };
  } catch {
    return {};
  }
}

export function parseLaneRoute(text: string): string | null {
  const m = /->\s+(\S+)/.exec(text.trim());
  return m ? m[1] : text.trim() || null;
}

export function parseUsage(text: string): { costUsd: number | null; calls: number } {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (typeof o.calls === "number") {
        return { costUsd: o.cost_usd ?? null, calls: o.calls };
      }
    } catch {
      // ignore
    }
  }
  return { costUsd: null, calls: 0 };
}

export interface LaneRow {
  kind: "lane";
  id: string;
  lane: string;
  state: string;
  harness: string;
  mode: string;
  model: string;
  tmux: string;
  cwd: string;
  pid: number | null;
  rssKb: number | null;
  cpuPct: number | null;
  uptimeSec: number | null;
  children: number | null;
  sessions: number;
  route: LaneDetail | null;
}

export interface RouteRow {
  kind: "route";
  id: string;
  lane: string;
  sessionId: string | null;
  model: string | null;
  mode: string | null;
  cwd: string | null;
  tmux: string | null;
}

export type AgentsRow = LaneRow | RouteRow;

export function mergeLanes(
  lanes: LaneInfo[],
  ps: Record<string, PsInfo>,
  sessions: BoopSession[],
): LaneRow[] {
  const perHarness = sessions.reduce<Record<string, number>>((m, s) => {
    m[s.harness] = (m[s.harness] ?? 0) + 1;
    return m;
  }, {});
  return lanes.map((l) => {
    const p = ps[l.lane];
    return {
      kind: "lane",
      id: l.lane,
      lane: l.lane,
      state: l.state,
      harness: l.harness,
      mode: l.mode,
      model: l.model,
      tmux: l.tmux,
      cwd: l.cwd,
      pid: p?.pid ?? null,
      rssKb: p?.rssKb ?? null,
      cpuPct: p?.cpuPct ?? null,
      uptimeSec: p?.uptimeSec ?? null,
      children: p?.children ?? null,
      sessions: perHarness[l.harness] ?? 0,
      route: null,
    };
  });
}

export function subRowsFor(row: AgentsRow): AgentsRow[] | undefined {
  if (row.kind !== "lane" || !row.route) return undefined;
  const r = row.route;
  const child: RouteRow = {
    kind: "route",
    id: `${row.lane}:route`,
    lane: row.lane,
    sessionId: r.sessionId ?? r.routeText,
    model: r.model,
    mode: r.mode,
    cwd: r.cwd,
    tmux: r.tmux,
  };
  return [child];
}

export interface BoopSnap {
  lanes: LaneRow[];
  sessions: BoopSession[];
  costUsd: number | null;
  calls: number;
}

export type RunCommand = (commandLine: string) => Promise<string>;

export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

function quoteArg(a: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(a) ? a : shellQuote(a);
}

export class BoopClient {
  constructor(
    private run: RunCommand,
    private bin: string = BOOP_BIN,
  ) {}

  private cmd(args: string[]): Promise<string> {
    return this.run([this.bin, ...args.map(quoteArg)].join(" "));
  }

  async poll(tick: number): Promise<BoopSnap> {
    const lanesInfo = parseLaneList(await this.cmd(["beep", "lane", "list"]));
    const psInfo = parsePs(await this.cmd(["beep", "ps"]));
    let sessions: BoopSession[] = [];
    let costUsd: number | null = null;
    let calls = 0;
    if (tick % 5 === 0) {
      try {
        sessions = parseSessions(
          await this.cmd(["db", "session", "list", "--limit", "8", "--format", "ndjson"]),
        );
      } catch {
        // sessions read failed; keep last
      }
      try {
        const u = parseUsage(
          await this.cmd(["db", "usage", "--limit", "1", "--format", "ndjson"]),
        );
        costUsd = u.costUsd;
        calls = u.calls;
      } catch {
        // usage read failed; keep last
      }
    }
    return { lanes: mergeLanes(lanesInfo, psInfo, sessions), sessions, costUsd, calls };
  }

  async route(lane: string): Promise<LaneDetail> {
    let detail: Partial<LaneDetail> = {};
    let routeText: string | null = null;
    try {
      detail = parseLaneGet(await this.cmd(["beep", "lane", "get", lane]));
    } catch {
      // get failed
    }
    try {
      routeText = parseLaneRoute(await this.cmd(["beep", "lane", "route", lane]));
    } catch {
      // route failed
    }
    const g = detail;
    return {
      lane: g.lane ?? null,
      state: g.state ?? null,
      harness: g.harness ?? null,
      tmux: g.tmux ?? null,
      cwd: g.cwd ?? null,
      model: g.model ?? null,
      mode: g.mode ?? null,
      sessionId: g.sessionId ?? null,
      routeText,
    };
  }

  async hail(lane: string, body: string, from?: string): Promise<string> {
    const args = ["beep", "hail", lane, "--body", body];
    if (from) args.push("--from", from);
    return this.cmd(args);
  }
}

export function startBoopPolling(
  client: BoopClient,
  onSnap: (snap: BoopSnap) => void,
  intervalMs = 1500,
): () => void {
  let tick = 0;
  let running = false;
  const runTick = async () => {
    if (running) return;
    running = true;
    try {
      onSnap(await client.poll(tick));
      tick++;
    } catch {
      // transient shellout failure; keep last snap
    } finally {
      running = false;
    }
  };
  void runTick();
  const timer = setInterval(() => {
    void runTick();
  }, intervalMs);
  return () => clearInterval(timer);
}
