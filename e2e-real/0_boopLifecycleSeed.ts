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
/// inside tmux cannot leak its server in.
export const boopEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.TMUX;
  env.TMUX_TMPDIR = tmuxDir;
  env.BOOP_DB = boopDb;
  env.BOOP_MAIL_DIR = boopDir;
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
  sql(`delete from agent_mail;
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
