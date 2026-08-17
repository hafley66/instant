import { describe, expect, it } from "vitest";
import {
  BoopAgentExplorerClient,
  boopAgentGraphCommand,
  parseBoopAgentGraph,
  projectBoopAgentGraph,
  projectAgentEdges,
} from "./1_boopAgentExplorer";

const producerFixture = {
  schema_version: 1,
  sessions: [
    { session: { harness: "codex", id: "root" }, cwd: "/repo", state: "live", last_activity_ts: 100 },
    { session: { harness: "codex", id: "child" }, cwd: "/repo", state: "done", last_activity_ts: 200 },
    { session: { harness: "opencode", id: "parallel" }, cwd: "/repo", state: "error", last_activity_ts: 210 },
  ],
  edges: [
    { id: "spawn-child", parent: { harness: "codex", id: "root" }, child: { harness: "codex", id: "child" }, kind: "spawn", timestamp: 110 },
    { id: "spawn-parallel", parent: { harness: "codex", id: "root" }, child: { harness: "opencode", id: "parallel" }, kind: "spawn", timestamp: 112 },
  ],
  shells: [{ lane: "plain-shell", parent_lane: "root", cwd: "/repo", tmux: "plain-shell", pid: 42, state: "live" }],
  trace_events: [
    { event_key: "send-1", lane: "root", session: "root", kind: "send", from_lane: "root", to_lane: "child", started_ts: 120, finished_ts: 130, detail: "begin", created_ts: 130 },
    { event_key: "send-2", lane: "root", session: "root", kind: "send", from_lane: "root", to_lane: "child", started_ts: 140, finished_ts: null, detail: "again", created_ts: 140 },
    { event_key: "work-1", lane: "parallel", session: "parallel", kind: "work", from_lane: null, to_lane: null, started_ts: 125, finished_ts: 150, detail: "work", created_ts: 150 },
    { event_key: "complete-1", lane: "child", session: "child", kind: "complete", from_lane: null, to_lane: null, started_ts: 200, finished_ts: null, detail: "done", created_ts: 200 },
    { event_key: "error-1", lane: "parallel", session: "parallel", kind: "error", from_lane: null, to_lane: null, started_ts: 210, finished_ts: null, detail: "failed", created_ts: 210 },
    { event_key: "exit-1", kind: "exit", lane: "plain-shell", session: null, from_lane: null, to_lane: null, started_ts: null, finished_ts: null, detail: "exit", created_ts: 220 },
    { event_key: "missing-time", kind: "receive", lane: "child", session: "child", from_lane: null, to_lane: null, started_ts: null, finished_ts: null, detail: "no timing", created_ts: 230 },
  ],
};

describe("Boop agent explorer", () => {
  it("projects nested spawn, repeated communication, parallel, shell-only, completion, error, and missing-time fixtures", () => {
    const graph = parseBoopAgentGraph(producerFixture);
    const snapshot = projectBoopAgentGraph(graph);
    expect(snapshot.tree.map((row) => ({ id: row.id, children: row.children?.map((child) => child.id) }))).toMatchInlineSnapshot(`
      [
        {
          "children": [
            "codex:child",
            "opencode:parallel",
          ],
          "id": "codex:root",
        },
        {
          "children": undefined,
          "id": "shell:plain-shell",
        },
      ]
    `);
    expect(snapshot.timeline.map(({ id, method, start, duration, from, to }) => ({ id, method, start, duration, from, to }))).toMatchInlineSnapshot(`
      [
        {
          "duration": 10,
          "from": "codex:root",
          "id": "send-1",
          "method": "SEND",
          "start": 120,
          "to": "codex:child",
        },
        {
          "duration": null,
          "from": "codex:root",
          "id": "send-2",
          "method": "SEND",
          "start": 140,
          "to": "codex:child",
        },
        {
          "duration": 25,
          "from": "opencode:parallel",
          "id": "work-1",
          "method": "WORK",
          "start": 125,
          "to": "",
        },
        {
          "duration": null,
          "from": "codex:child",
          "id": "complete-1",
          "method": "DONE",
          "start": 200,
          "to": "",
        },
        {
          "duration": null,
          "from": "opencode:parallel",
          "id": "error-1",
          "method": "ERROR",
          "start": 210,
          "to": "",
        },
        {
          "duration": null,
          "from": "shell:plain-shell",
          "id": "exit-1",
          "method": "EXIT",
          "start": null,
          "to": "",
        },
        {
          "duration": null,
          "from": "codex:child",
          "id": "missing-time",
          "method": "RECV",
          "start": null,
          "to": "",
        },
      ]
    `);
    expect(projectAgentEdges(graph).filter((edge) => edge.kind === "send")).toMatchInlineSnapshot(`
      [
        {
          "from": "codex:root",
          "id": "codex:root->codex:child:send",
          "kind": "send",
          "occurrenceCount": 2,
          "timestamp": 120,
          "to": "codex:child",
        },
      ]
    `);
  });

  it("performs one bounded command and replaces only after parsing and validation", async () => {
    const queries: unknown[] = [];
    const client = new BoopAgentExplorerClient(async (query) => {
      queries.push(query);
      return JSON.stringify(producerFixture);
    });
    const graph = await client.load({ cwd: "/repo", includeHistory: true });
    expect(queries).toMatchInlineSnapshot(`
      [
        {
          "cwd": "/repo",
          "includeHistory": true,
        },
      ]
    `);
    expect(boopAgentGraphCommand({ cwd: "/repo", includeHistory: true }, "/opt/boop")).toBe("/opt/boop agent sessions --format json --cwd '/repo' --history");
    expect(graph.schemaVersion).toBe("boop-agent/1");
    expect(() => parseBoopAgentGraph({ ...producerFixture, schema_version: 2 })).toThrow("unsupported");
  });
});
