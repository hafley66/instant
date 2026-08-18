import { describe, expect, it } from "vitest";
import { parseBoopNetworkEvents } from "./1_boopNetwork";

describe("Boop network event contract", () => {
  it("parses the bounded NDJSON transport without graph projection", () => {
    const rows = [
      { event_id: 9, event_key: "event-9", lane: "codex-a", trace: "trace-a", session: "session-a", from_lane: "root", to_lane: "codex-a", kind: "delivery", started_ts: 100, finished_ts: 107, delivery_state: "delivered", classification: "completed", detail: "message delivered", created_ts: 107 },
      { event_id: 8, event_key: "event-8", lane: "claude-b", trace: "trace-a", session: "session-b", from_lane: "", to_lane: "", kind: "turn-start", started_ts: 90, finished_ts: null, delivery_state: "", classification: "started", detail: "turn submitted", created_ts: 90 },
    ];

    expect(parseBoopNetworkEvents(rows.map((row) => JSON.stringify(row)).join("\n"))).toMatchInlineSnapshot(`
      [
        {
          "classification": "completed",
          "created_ts": 107,
          "delivery_state": "delivered",
          "detail": "message delivered",
          "event_id": 9,
          "event_key": "event-9",
          "finished_ts": 107,
          "from_lane": "root",
          "kind": "delivery",
          "lane": "codex-a",
          "session": "session-a",
          "started_ts": 100,
          "to_lane": "codex-a",
          "trace": "trace-a",
        },
        {
          "classification": "started",
          "created_ts": 90,
          "delivery_state": "",
          "detail": "turn submitted",
          "event_id": 8,
          "event_key": "event-8",
          "finished_ts": null,
          "from_lane": "",
          "kind": "turn-start",
          "lane": "claude-b",
          "session": "session-b",
          "started_ts": 90,
          "to_lane": "",
          "trace": "trace-a",
        },
      ]
    `);
  });

  it("maps an empty response to an empty row set", () => {
    expect(parseBoopNetworkEvents("\n")).toMatchInlineSnapshot(`[]`);
  });
});
