import { describe, expect, it } from "vitest";
import { initialTerminalWheelState, reduceTerminalWheel } from "./0_terminalWheel";

describe("terminal wheel state", () => {
  it("follows the mouse mode parsed from the live terminal stream", () => {
    const events = [
      { type: "sync", mouseMode: "none" },
      { type: "sync", mouseMode: "any" },
      { type: "wheel", mouseMode: "any" },
      { type: "sync", mouseMode: "none" },
      { type: "wheel", mouseMode: "none" },
    ] as const;
    const states = events.reduce<ReturnType<typeof reduceTerminalWheel>[]>((all, event) => {
      all.push(reduceTerminalWheel(all[all.length - 1] ?? initialTerminalWheelState, event));
      return all;
    }, []);

    expect(states).toMatchInlineSnapshot(`
      [
        {
          "mouseMode": "none",
          "native": false,
          "wheels": 0,
        },
        {
          "mouseMode": "any",
          "native": true,
          "wheels": 0,
        },
        {
          "mouseMode": "any",
          "native": true,
          "wheels": 1,
        },
        {
          "mouseMode": "none",
          "native": false,
          "wheels": 1,
        },
        {
          "mouseMode": "none",
          "native": false,
          "wheels": 2,
        },
      ]
    `);
  });
});

describe("shift bypasses an app that owns the mouse", () => {
  it("keeps the wheel native while the app tracks the mouse", () => {
    const state = reduceTerminalWheel(initialTerminalWheelState, {
      type: "wheel",
      mouseMode: "any",
    });
    expect(state.native).toBe(true);
  });

  it("takes the wheel back when shift is held", () => {
    const state = reduceTerminalWheel(initialTerminalWheelState, {
      type: "wheel",
      mouseMode: "any",
      bypass: true,
    });
    expect(state.native).toBe(false);
  });

  it("leaves a pane with no mouse tracking on the scrollback path", () => {
    const state = reduceTerminalWheel(initialTerminalWheelState, {
      type: "wheel",
      mouseMode: "none",
    });
    expect(state.native).toBe(false);
  });
});
