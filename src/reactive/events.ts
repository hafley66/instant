import type { StatusRow } from "./statusModel";

export interface AppEvents {
  "status.poll.requested": { sequence: number };
  "status.poll.completed": { sequence: number; rows: StatusRow[] };
}

