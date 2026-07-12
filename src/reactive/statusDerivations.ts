import type { StatusState } from "../plugin";
import type { StatusRow } from "./statusModel";

const RANK: Record<StatusState, number> = {
  down: 0,
  degraded: 1,
  unknown: 2,
  idle: 3,
  up: 4,
};

export function aggregateStatus(rows: StatusRow[]): StatusState {
  if (!rows.length) return "unknown";
  return rows.reduce<StatusState>(
    (state, row) => (RANK[row.report.state] < RANK[state] ? row.report.state : state),
    "up",
  );
}

