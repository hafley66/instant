import { describe, expect, it, vi } from "vitest";
import { CmdClickGestureTracker, CmdClickRouter } from "./0_clickRouter";

describe("CmdClickRouter", () => {
  it("runs the first handling route and emits its id", async () => {
    const router = new CmdClickRouter();
    const calls = vi.fn();
    router.register({ id: "miss", handle: () => false });
    router.register({ id: "file", handle: (request) => { calls(request); return true; } });
    router.register({ id: "later", handle: () => true });
    const events: unknown[] = [];
    router.routed.subscribe((event) => events.push(event));

    expect(await router.dispatch({ token: " src/main.ts ", cwd: "/repo", source: "terminal" })).toBe("file");
    expect({ calls: calls.mock.calls, events }).toMatchInlineSnapshot(`
      {
        "calls": [
          [
            {
              "cwd": "/repo",
              "source": "terminal",
              "token": "src/main.ts",
            },
          ],
        ],
        "events": [
          {
            "cwd": "/repo",
            "routeId": "file",
            "source": "terminal",
            "token": "src/main.ts",
          },
        ],
      }
    `);
  });
});

describe("CmdClickGestureTracker", () => {
  it("activates on pointerup and rejects a drag", () => {
    const tracker = new CmdClickGestureTracker();
    const events: unknown[] = [];
    tracker.events.subscribe((event) => events.push(event));
    const down = { pointerId: 4, x: 10, y: 20, button: 0, metaKey: true };
    expect(tracker.pointerDown(down, "src/main.ts")).toBe(true);
    expect(tracker.pointerUp({ ...down, x: 12 })).toBe("src/main.ts");
    expect(tracker.pointerDown(down, "README.md")).toBe(true);
    tracker.pointerMove({ ...down, x: 30 });
    expect(tracker.pointerUp({ ...down, x: 30 })).toBeNull();
    expect(events.map((event) => ({ type: (event as { type: string }).type, dragged: (event as { dragged: boolean }).dragged })))
      .toMatchInlineSnapshot(`
        [
          {
            "dragged": false,
            "type": "pointerdown",
          },
          {
            "dragged": false,
            "type": "pointerup",
          },
          {
            "dragged": false,
            "type": "pointerdown",
          },
          {
            "dragged": true,
            "type": "pointermove",
          },
          {
            "dragged": true,
            "type": "pointerup",
          },
        ]
      `);
  });
});
