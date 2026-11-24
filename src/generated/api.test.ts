import { describe, expect, it } from "vitest";
import { operations, paths } from "./api";

describe("generated activity HTTP contracts", () => {
  it("builds the authoritative config request", () => {
    expect(paths.activityConfig.endpoint.request(undefined)).toEqual({
      url: "http://127.0.0.1:8787/config",
      method: "GET",
    });
  });

  it("builds a typed ingest request", () => {
    const event: paths.activityIngest.Input = {
      type: "editor",
      event: "save",
      path: "/tmp/a.ts",
      ts: 42,
    };
    expect(paths.activityIngest.endpoint.request(event)).toEqual({
      url: "http://127.0.0.1:8787/ingest",
      method: "POST",
      body: event,
    });
  });

  it("inverts request and decode for every operation and keeps the OpenAPI operation", () => {
    const samples: { [K in keyof typeof operations]: Parameters<(typeof operations)[K]["request"]>[0] } = {
      worktrees: undefined,
      events: undefined,
      activityConfig: undefined,
      activityHeartbeat: { revision: 3, rulesCount: 2 },
      activityIngest: { type: "editor", event: "save", path: "/tmp/a.ts", ts: 42 },
    };
    const outputs = {
      worktrees: [{ origin: "o", clone: "/c", worktree: "/c/w", branch: "b", head: "h", is_main: false, dirty: true }],
      events: "data: {}\n\n",
      activityConfig: { rules: [] },
      activityHeartbeat: "ok",
      activityIngest: "ok",
    };
    const names = Object.keys(operations) as (keyof typeof operations)[];
    expect(
      names.map((name) => {
        const operation = operations[name] as (typeof operations)["activityIngest"];
        const response = operation.encode(outputs[name] as never);
        return {
          name,
          meta: { ...operation.meta, operation: Object.keys(operation.meta.operation) },
          inputBack: operation.input(operation.request(samples[name] as never)),
          response,
          outputBack: operation.decode(response),
        };
      }),
    ).toMatchInlineSnapshot(`
      [
        {
          "inputBack": undefined,
          "meta": {
            "method": "GET",
            "operation": [
              "operationId",
              "responses",
            ],
            "operationId": "worktrees",
            "path": "/worktrees",
            "responseMediaType": "application/json",
            "server": "http://127.0.0.1:7748",
          },
          "name": "worktrees",
          "outputBack": [
            {
              "branch": "b",
              "clone": "/c",
              "dirty": true,
              "head": "h",
              "is_main": false,
              "origin": "o",
              "worktree": "/c/w",
            },
          ],
          "response": {
            "body": [
              {
                "branch": "b",
                "clone": "/c",
                "dirty": true,
                "head": "h",
                "is_main": false,
                "origin": "o",
                "worktree": "/c/w",
              },
            ],
            "headers": {
              "content-type": "application/json",
            },
            "status": 200,
          },
        },
        {
          "inputBack": undefined,
          "meta": {
            "method": "GET",
            "operation": [
              "operationId",
              "responses",
            ],
            "operationId": "events",
            "path": "/events",
            "responseMediaType": "text/event-stream",
            "server": "http://127.0.0.1:7748",
          },
          "name": "events",
          "outputBack": "data: {}

      ",
          "response": {
            "body": "data: {}

      ",
            "headers": {
              "content-type": "text/event-stream",
            },
            "status": 200,
          },
        },
        {
          "inputBack": undefined,
          "meta": {
            "method": "GET",
            "operation": [
              "operationId",
              "servers",
              "responses",
            ],
            "operationId": "activityConfig",
            "path": "/config",
            "responseMediaType": "application/json",
            "server": "http://127.0.0.1:8787",
          },
          "name": "activityConfig",
          "outputBack": {
            "rules": [],
          },
          "response": {
            "body": {
              "rules": [],
            },
            "headers": {
              "content-type": "application/json",
            },
            "status": 200,
          },
        },
        {
          "inputBack": {
            "revision": 3,
            "rulesCount": 2,
          },
          "meta": {
            "method": "POST",
            "operation": [
              "operationId",
              "servers",
              "requestBody",
              "responses",
            ],
            "operationId": "activityHeartbeat",
            "path": "/heartbeat",
            "responseMediaType": "text/plain",
            "server": "http://127.0.0.1:8787",
          },
          "name": "activityHeartbeat",
          "outputBack": "ok",
          "response": {
            "body": "ok",
            "headers": {
              "content-type": "text/plain",
            },
            "status": 200,
          },
        },
        {
          "inputBack": {
            "event": "save",
            "path": "/tmp/a.ts",
            "ts": 42,
            "type": "editor",
          },
          "meta": {
            "method": "POST",
            "operation": [
              "operationId",
              "servers",
              "requestBody",
              "responses",
            ],
            "operationId": "activityIngest",
            "path": "/ingest",
            "responseMediaType": "text/plain",
            "server": "http://127.0.0.1:8787",
          },
          "name": "activityIngest",
          "outputBack": "ok",
          "response": {
            "body": "ok",
            "headers": {
              "content-type": "text/plain",
            },
            "status": 200,
          },
        },
      ]
    `);
  });
});
