import { describe, expect, it } from "vitest";
import { parseBoopNetworkEvents } from "./1_boopNetwork";
import { projectBoopEventsToMarbler } from "./1a_BoopNetworkGraph";

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

  it("groups timestamped transport events into stable Marbler agent lanes", () => {
    const events = parseBoopNetworkEvents([
      { event_id: 1, event_key: "send-1", lane: "root", trace: "trace-a", session: "root-session", from_lane: "root", to_lane: "worker", kind: "delivery", started_ts: 100, finished_ts: 105, delivery_state: "delivered", classification: "completed", detail: "implement it", created_ts: 100 },
      { event_id: 2, event_key: "turn-1", lane: "worker", trace: "trace-a", session: "worker-session", from_lane: "", to_lane: "", kind: "turn-finish", started_ts: 110, finished_ts: 140, delivery_state: "", classification: "completed", detail: "done", created_ts: 140 },
    ].map((row) => JSON.stringify(row)).join("\n"));

    expect(projectBoopEventsToMarbler(events)).toMatchInlineSnapshot(`
      [
        {
          "duration": 5,
          "frames": [
            {
              "direction": "out",
              "id": "send-1",
              "kind": "mail-out",
              "peer": "worker",
              "preview": "implement it",
              "repeat": 1,
              "t": 0,
            },
          ],
          "from": "worker",
          "id": "root",
          "initiator": "root-session",
          "method": "AGENT",
          "name": "root",
          "parentId": null,
          "phases": [
            {
              "end": 5,
              "kind": "send",
              "start": 0,
            },
          ],
          "preview": "1 lifecycle and message events",
          "size": "1 events",
          "start": 0,
          "status": 200,
          "to": "root",
          "type": "tool",
        },
        {
          "duration": 30,
          "frames": [
            {
              "direction": "self",
              "id": "turn-1",
              "kind": "turn-finish",
              "peer": null,
              "preview": "done",
              "repeat": 1,
              "t": 10,
            },
          ],
          "from": "worker",
          "id": "worker",
          "initiator": "worker-session",
          "method": "AGENT",
          "name": "worker",
          "parentId": null,
          "phases": [
            {
              "end": 40,
              "kind": "receive",
              "start": 10,
            },
          ],
          "preview": "1 lifecycle and message events",
          "size": "1 events",
          "start": 10,
          "status": 200,
          "to": "worker",
          "type": "tool",
        },
      ]
    `);
  });
});
