// Scratch-store seeding for the Boop lifecycle tier. The real boop sqlite
// schema is created by the boop binary itself, then synthetic rows are written
// with sqlite3. No RPC mocks, no window hooks, no product doubles: the panel
// still reads boop_session_graph / boop_lane_events through instant-serve.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const port = Number(process.env.INSTANT_BOOP_LIFE_PORT ?? 47807);
export const scratchRoot = process.env.INSTANT_BOOP_LIFE_TMP ?? `/tmp/instant-boop-life-${port}`;
export const boopDir = path.join(scratchRoot, "boop");
export const tmuxDir = path.join(scratchRoot, "tmux");
export const boopDb = path.join(boopDir, "boop.db");
const BOOP = process.env.BOOP_BIN ?? path.join(process.env.HOME ?? "", ".cargo/bin/boop");

/// boop pointed only at the scratch store/socket; TMUX stripped so a runner
/// inside tmux cannot leak its server in. Every Boop/harness discovery root is
/// forced under the scratch root so `dirs::home_dir()` (which ignores HOME on
/// macOS) cannot reach the operator's real route registry.
export const boopEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.TMUX;
  delete env.BOOP_MAIL_DIR;
  delete env.BOOP_READER_HOME;
  delete env.CODEX_HOME;
  const home = path.join(scratchRoot, "home");
  const codex = path.join(scratchRoot, "codex");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(codex, { recursive: true });
  env.TMUX_TMPDIR = tmuxDir;
  env.BOOP_DB = boopDb;
  env.BOOP_MAIL_DIR = boopDir;
  env.BOOP_READER_HOME = home;
  env.CODEX_HOME = codex;
  env.BOOP_NO_SYNC = "1";
  return env;
};

export const sql = (query: string): string => {
  const r = spawnSync("sqlite3", ["-cmd", ".timeout 5000", boopDb, query], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`sqlite3: ${r.stderr}`);
  return r.stdout.trim();
};

/// Create the real schema through boop, then clear every row this tier writes.
export function seedStore(): void {
  fs.mkdirSync(boopDir, { recursive: true });
  fs.mkdirSync(tmuxDir, { recursive: true });
  const r = spawnSync(BOOP, ["beep", "selection", "list"], { env: boopEnv(), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`boop schema init: ${r.stderr}`);
  resetStore();
}

export function resetStore(): void {
  sql(`delete from agent_trace_event;
       delete from agent_mail;
       delete from agent_delivery_transition;
       delete from agent_live;
       delete from agent_lane;
       delete from agent_route;
       delete from agent_session;
       delete from agent_edge;
       delete from agent_turn;`);
}

interface LaneSeed {
  lane: string;
  parent?: string;
  cwd?: string;
  state?: "live" | "dead" | "unknown";
  goal?: string;
  spawnedTs: number;
}

/// A durable shell lane (`agent_lane` with no harness) plus its reported
/// status. The graph projects it without any tmux or process evidence.
export function seedLane(seed: LaneSeed): void {
  const parentLaneId = seed.parent
    ? `(select id from dict_session where value='${seed.parent}')`
    : "NULL";
  const cwdId = seed.cwd
    ? `(select id from dict_cwd where value='${seed.cwd}')`
    : "NULL";
  sql(`insert or ignore into dict_session(value) values ('${seed.lane}')`);
  if (seed.parent) sql(`insert or ignore into dict_session(value) values ('${seed.parent}')`);
  if (seed.cwd) sql(`insert or ignore into dict_cwd(value) values ('${seed.cwd}')`);
  if (seed.state && seed.state !== "unknown")
    sql(`insert or ignore into dict_status(value) values ('${seed.state}')`);
  const goal = (seed.goal ?? "").replace(/'/g, "''");
  sql(`insert into agent_lane(lane_id, cwd_id, parent_lane_id, goal, spawned_ts)
       values ((select id from dict_session where value='${seed.lane}'),
               ${cwdId}, ${parentLaneId}, '${goal}', ${seed.spawnedTs})`);
  if (seed.state === "live") {
    sql(`insert or replace into agent_live(session_id, pid, status_id)
         values ((select id from dict_session where value='${seed.lane}'),
                 4242, (select id from dict_status where value='live'))`);
  } else if (seed.state === "dead") {
    sql(`insert or replace into agent_live(session_id, pid, status_id)
         values ((select id from dict_session where value='${seed.lane}'),
                 NULL, (select id from dict_status where value='dead'))`);
  }
}

interface MailSeed {
  id: string;
  from: string;
  to: string;
  kind?: string;
  body?: string;
  /// Seconds before now; deterministic relative stamp, never a live send.
  ageSec: number;
}

export function seedMail(seed: MailSeed): void {
  const body = (seed.body ?? "").replace(/'/g, "''");
  const stamp = `strftime('%Y-%m-%d %H:%M:%f','now','-${seed.ageSec} seconds')`;
  // The agent_mail insert trigger requires a delivery transition to exist for
  // the message; a synthetic delivered row is the whole written history.
  sql(`insert or replace into agent_delivery_transition(message_id, sequence, route,
         outcome, detail, at_ms)
       values ('${seed.id}', 1, '${seed.to}', 'delivered', '', ${NOW_SQL})`);
  sql(`insert or replace into agent_mail(message_id, mailbox, from_route, to_route,
         from_timestamp, kind, body)
       values ('${seed.id}', 'bus', '${seed.from}', '${seed.to}', ${stamp},
               '${seed.kind ?? "note"}', '${body}')`);
}

const NOW_SQL = `CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'),4,3) AS INTEGER)`;

export function laneCount(): number {
  return Number(sql("select count(*) from agent_lane"));
}

/// `count` durable shell lanes in one statement, so a large synthetic store can
/// be built without one sqlite3 process per row. Lanes are always kept by the
/// graph projection, so they render regardless of the 24h activity window.
export function seedBulkLanes(count: number, prefix = "bulk-lane"): void {
  sql(`insert or ignore into dict_cwd(value) values ('/tmp/e2e-net');`);
  sql(`insert or ignore into dict_status(value) values ('live');`);
  sql(`with recursive seq(i) as (select 1 union all select i+1 from seq where i < ${count})
       insert or ignore into dict_session(value) select '${prefix}-'||i from seq;`);
  sql(`insert into agent_lane(lane_id, cwd_id, parent_lane_id, goal, spawned_ts)
       select s.id, (select id from dict_cwd where value='/tmp/e2e-net'), null, 'bulk goal', ${NOW_SQL}
         from dict_session s where s.value like '${prefix}-%';`);
  sql(`insert or replace into agent_live(session_id, pid, status_id)
       select s.id, 4242, (select id from dict_status where value='live')
         from dict_session s where s.value like '${prefix}-%';`);
}

/// `count` durable harness sessions in one statement. These are the rows the
/// graph's set-wise session query must scan, so a big store stresses both the
/// session projection and the per-lane trace read the panel no longer asks for.
export function seedBulkSessions(count: number, prefix = "bulk-sess"): void {
  sql(`insert or ignore into dict_cwd(value) values ('/tmp/e2e-net');`);
  sql(`insert or ignore into dict_harness(value) values ('codex');`);
  sql(`with recursive seq(i) as (select 1 union all select i+1 from seq where i < ${count})
       insert or ignore into dict_session(value) select '${prefix}-'||i from seq;`);
  sql(`insert into agent_session(session_id, harness_id, cwd_id, started_ts)
       select s.id, (select id from dict_harness where value='codex'),
              (select id from dict_cwd where value='/tmp/e2e-net'), ${NOW_SQL}
         from dict_session s where s.value like '${prefix}-%';`);
}

/// `turnsPerSession` transcript turns for every prefixed session. The graph's
/// `turns`/`usage` CTEs aggregate `agent_turn` per session, so long transcripts
/// are the native-session load the session projection must stay bounded under.
export function seedBulkTurns(turnsPerSession: number, prefix = "bulk-sess"): void {
  sql(`insert or ignore into dict_role(value) values ('assistant');`);
  sql(`insert or ignore into dict_cwd(value) values ('/tmp/e2e-net');`);
  sql(`with recursive t(n) as (select 1 union all select n+1 from t where n < ${turnsPerSession})
       insert into agent_turn(session_id, turn, ts, role_id, said, cwd_id)
       select s.id, t.n, ${NOW_SQL} + t.n,
              (select id from dict_role where value='assistant'), 'bulk turn',
              (select id from dict_cwd where value='/tmp/e2e-net')
         from dict_session s, t
        where s.value like '${prefix}-%';`);
}

/// `count` trace events spread over `lanes` prefixed lanes. The panel no longer
/// requests trace events, so a large event table is exactly the load the graph
/// read must stay bounded under.
export function seedBulkEvents(count: number, lanes: number, prefix = "bulk-lane"): void {
  sql(`insert or ignore into dict_trace_kind(value) values ('mail');`);
  sql(`with recursive seq(i) as (select 1 union all select i+1 from seq where i < ${count})
       insert into agent_trace_event(event_key, lane_id, kind_id, created_ts)
       select 'seed-ev-'||i,
              (select id from dict_session where value='${prefix}-'||(1 + (i % ${lanes}))),
              (select id from dict_trace_kind where value='mail'), ${NOW_SQL} + i
         from seq;`);
}
