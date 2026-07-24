import { describe, expect, it } from "vitest";
import { swarmRows } from "./0_rows";

describe("swarmRows", () => {
  it("normalizes provider, agent, reservation, and bead records", () => {
    const snapshot = {
      providers: [{ name: "agent_mail", status: "ready", source: "mail", warning: "stale" }],
      agents: [{ agent_id: "worker-1", state: "working", task: "index docs" }],
      reservations: [{ id: "reserve-1", status: "active", path: "src/0_types.ts" }],
      beads: { ready: [{ id: "b-1", title: "render swarm", owner: "worker-1" }], blocked: [{ id: "b-2", reason: "dependency" }] },
    };

    expect({
      providers: swarmRows(snapshot, "provider"),
      agents: swarmRows(snapshot, "agent"),
      reservations: swarmRows(snapshot, "reservation"),
      work: swarmRows(snapshot, "work"),
    }).toMatchInlineSnapshot(`
      {
        "agents": [
          {
            "detail": "task=index docs",
            "id": "agent:worker-1:0",
            "kind": "agent",
            "status": "working",
            "title": "worker-1",
          },
        ],
        "providers": [
          {
            "detail": "mail · stale",
            "id": "provider:agent_mail",
            "kind": "provider",
            "status": "ready",
            "title": "agent_mail",
          },
        ],
        "reservations": [
          {
            "detail": "path=src/0_types.ts",
            "id": "reservation:reserve-1:0",
            "kind": "reservation",
            "status": "active",
            "title": "reserve-1",
          },
        ],
        "work": [
          {
            "detail": "owner=worker-1",
            "id": "work:render swarm:0",
            "kind": "work",
            "status": "ready",
            "title": "render swarm",
          },
          {
            "detail": "reason=dependency",
            "id": "work:b-2:0",
            "kind": "work",
            "status": "blocked",
            "title": "b-2",
          },
        ],
      }
    `);
  });
});
