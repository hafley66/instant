import { describe, expect, it } from "vitest";
import { applyStateUpdate } from "./1_state";
import type { State } from "./0_types";

describe("json-rx state updates", () => {
  const initial: State = {
    value: "watching",
    usage: 0.4,
    attempts: 1,
  };

  it("supports replace, patch, and set", () => {
    const replaced = applyStateUpdate(initial, {
      op: "replace",
      state: { value: "checking", usage: 0.7 },
    });
    const patched = applyStateUpdate(replaced, {
      op: "patch",
      patch: [
        { op: "replace", path: "/usage", value: 0.86 },
        { op: "add", path: "/source", value: "claude" },
      ],
    });
    const set = applyStateUpdate(patched, {
      op: "set",
      path: "/attempts",
      value: 2,
    });

    expect(set).toMatchInlineSnapshot(`
      {
        "attempts": 2,
        "source": "claude",
        "usage": 0.86,
        "value": "checking",
      }
    `);
  });
});
