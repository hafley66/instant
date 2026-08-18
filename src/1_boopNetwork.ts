import { z } from "zod";

export const boopNetworkEventSchema = z.object({
  event_id: z.number(),
  event_key: z.string(),
  lane: z.string(),
  trace: z.string(),
  session: z.string(),
  from_lane: z.string(),
  to_lane: z.string(),
  kind: z.string(),
  started_ts: z.number().nullable(),
  finished_ts: z.number().nullable(),
  delivery_state: z.string(),
  classification: z.string(),
  detail: z.string(),
  created_ts: z.number(),
});

export type BoopNetworkEvent = z.infer<typeof boopNetworkEventSchema>;

export function parseBoopNetworkEvents(text: string): BoopNetworkEvent[] {
  if (!text.trim()) return [];
  return text.trim().split("\n").map((line) => boopNetworkEventSchema.parse(JSON.parse(line)));
}
