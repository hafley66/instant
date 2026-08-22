import { describe, expect, it } from "vitest";
import { parseSequenceSource } from "./1_sequence";

describe("sequence diagram source model", () => {
  it("keeps Mermaid actor order, message endpoints, and nested group identity", () => {
    const model = parseSequenceSource("mermaid", `sequenceDiagram
participant UI as User Interface
participant API
participant DB as Database
loop retry
  UI->>API: request
  API->>DB: query
  alt hit
    DB-->>API: row
  else miss
    DB-->>API: empty
  end
end`);

    expect(model).toMatchInlineSnapshot(`
      {
        "activations": [],
        "actors": [
          {
            "id": "actor/UI",
            "label": "User Interface",
            "ordinal": 0,
          },
          {
            "id": "actor/API",
            "label": "API",
            "ordinal": 1,
          },
          {
            "id": "actor/DB",
            "label": "Database",
            "ordinal": 2,
          },
        ],
        "groups": [
          {
            "id": "group/loop/0",
            "kind": "loop",
            "label": "retry",
            "ordinal": 0,
          },
          {
            "id": "group/alt/1",
            "kind": "alt",
            "label": "hit",
            "ordinal": 1,
            "parentId": "group/loop/0",
          },
        ],
        "language": "mermaid",
        "messages": [
          {
            "groupIds": [
              "group/loop/0",
            ],
            "id": "message/0",
            "label": "request",
            "ordinal": 0,
            "sourceId": "actor/UI",
            "targetId": "actor/API",
          },
          {
            "groupIds": [
              "group/loop/0",
            ],
            "id": "message/1",
            "label": "query",
            "ordinal": 1,
            "sourceId": "actor/API",
            "targetId": "actor/DB",
          },
          {
            "groupIds": [
              "group/loop/0",
              "group/alt/1",
            ],
            "id": "message/2",
            "label": "row",
            "ordinal": 2,
            "sourceId": "actor/DB",
            "targetId": "actor/API",
          },
          {
            "groupIds": [
              "group/loop/0",
              "group/alt/1",
            ],
            "id": "message/3",
            "label": "empty",
            "ordinal": 3,
            "sourceId": "actor/DB",
            "targetId": "actor/API",
          },
        ],
      }
    `);
  });

  it("discovers D2 actors from connections and preserves group ancestry", () => {
    const model = parseSequenceSource("d2", `shape: sequence_diagram
retry: {
  api -> db: query
}`);

    expect({
      actors: model.actors.map(({ id, label }) => ({ id, label })),
      messages: model.messages,
      groups: model.groups,
    }).toMatchInlineSnapshot(`
      {
        "actors": [
          {
            "id": "actor/api",
            "label": "api",
          },
          {
            "id": "actor/db",
            "label": "db",
          },
        ],
        "groups": [
          {
            "id": "group/d2-group/0",
            "kind": "d2-group",
            "label": "retry",
            "ordinal": 0,
          },
        ],
        "messages": [
          {
            "groupIds": [
              "group/d2-group/0",
            ],
            "id": "message/0",
            "label": "query",
            "ordinal": 0,
            "sourceId": "actor/api",
            "targetId": "actor/db",
          },
        ],
      }
    `);
  });
});
