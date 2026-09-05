import { describe, expect, it } from "vitest";
import { InspectorMachine, inspectorNext, INSPECTOR_HIDDEN, type InspectorEvent } from "./0_inspectorState";

// Drive a machine through a script and report what the card shows after each step.
const run = (...events: InspectorEvent[]) => {
  const machine = new InspectorMachine();
  const trace = events.map((event) => {
    machine.send(event);
    return `${event} -> ${machine.visible ? "shown" : "hidden"}${machine.pinned ? " pinned" : ""}`;
  });
  return { trace, visible: machine.visible, pinned: machine.pinned };
};

describe("inspector card state", () => {
  it("shows only while meta is held over an openable token", () => {
    expect(run("pointer-enter-token")).toMatchInlineSnapshot(`
      {
        "pinned": false,
        "trace": [
          "pointer-enter-token -> hidden",
        ],
        "visible": false,
      }
    `);
    expect(run("meta-down", "pointer-enter-token")).toMatchInlineSnapshot(`
      {
        "pinned": false,
        "trace": [
          "meta-down -> hidden",
          "pointer-enter-token -> shown",
        ],
        "visible": true,
      }
    `);
  });

  it("hides on a dispatched cmd-click even with meta still held and the pointer still on the token", () => {
    expect(run("meta-down", "pointer-enter-token", "click-dispatched")).toMatchInlineSnapshot(`
      {
        "pinned": false,
        "trace": [
          "meta-down -> hidden",
          "pointer-enter-token -> shown",
          "click-dispatched -> hidden",
        ],
        "visible": false,
      }
    `);
  });

  it("hides when the terminal tab goes hidden", () => {
    expect(run("meta-down", "pointer-enter-token", "tab-hidden")).toMatchInlineSnapshot(`
      {
        "pinned": false,
        "trace": [
          "meta-down -> hidden",
          "pointer-enter-token -> shown",
          "tab-hidden -> hidden",
        ],
        "visible": false,
      }
    `);
  });

  it("hides when the window loses focus, and forgets the meta key the keyup will never report", () => {
    const machine = new InspectorMachine();
    machine.send("meta-down");
    machine.send("pointer-enter-token");
    machine.send("window-blur");
    expect({ visible: machine.visible, state: machine.state }).toMatchInlineSnapshot(`
      {
        "state": {
          "insideCard": false,
          "metaHeld": false,
          "pinned": false,
          "visible": false,
        },
        "visible": false,
      }
    `);
    // Meta is forgotten, so a stray hover cannot repaint the card until a fresh meta-down.
    machine.send("pointer-enter-token");
    expect(machine.visible).toBe(false);
  });

  it("keeps a pinned card through pointer-leave, drops it on click, escape, or tab switch", () => {
    const pinnedThen = (...events: InspectorEvent[]) => {
      const machine = new InspectorMachine();
      machine.send("meta-down");
      machine.send("pointer-enter-token");
      machine.send("card-enter");
      machine.send("pin");
      for (const event of events) machine.send(event);
      return { visible: machine.visible, pinned: machine.pinned };
    };
    expect({
      leave: pinnedThen("pointer-leave-terminal"),
      metaUpThenLeave: pinnedThen("meta-up", "card-leave", "pointer-leave-terminal"),
      click: pinnedThen("click-dispatched"),
      escape: pinnedThen("escape"),
      tab: pinnedThen("tab-hidden"),
      blur: pinnedThen("window-blur"),
    }).toMatchInlineSnapshot(`
      {
        "blur": {
          "pinned": false,
          "visible": false,
        },
        "click": {
          "pinned": false,
          "visible": false,
        },
        "escape": {
          "pinned": false,
          "visible": false,
        },
        "leave": {
          "pinned": true,
          "visible": true,
        },
        "metaUpThenLeave": {
          "pinned": true,
          "visible": true,
        },
        "tab": {
          "pinned": false,
          "visible": false,
        },
      }
    `);
  });

  it("survives meta-up while the pointer sits in the card, and hides when the pointer leaves it", () => {
    expect(run("meta-down", "pointer-enter-token", "card-enter", "meta-up", "card-leave")).toMatchInlineSnapshot(`
      {
        "pinned": false,
        "trace": [
          "meta-down -> hidden",
          "pointer-enter-token -> shown",
          "card-enter -> shown",
          "meta-up -> shown",
          "card-leave -> hidden",
        ],
        "visible": false,
      }
    `);
  });

  it("lets the pointer cross from the token into the card while meta is held", () => {
    expect(run("meta-down", "pointer-enter-token", "pointer-leave-terminal", "card-enter")).toMatchInlineSnapshot(`
      {
        "pinned": false,
        "trace": [
          "meta-down -> hidden",
          "pointer-enter-token -> shown",
          "pointer-leave-terminal -> shown",
          "card-enter -> shown",
        ],
        "visible": true,
      }
    `);
  });

  it("hides on meta-up when the pointer is neither in the card nor the card pinned", () => {
    expect(run("meta-down", "pointer-enter-token", "meta-up")).toMatchInlineSnapshot(`
      {
        "pinned": false,
        "trace": [
          "meta-down -> hidden",
          "pointer-enter-token -> shown",
          "meta-up -> hidden",
        ],
        "visible": false,
      }
    `);
  });

  it("keeps the card up when the pointer leaves the card with meta still held", () => {
    expect(run("meta-down", "pointer-enter-token", "card-enter", "card-leave")).toMatchInlineSnapshot(`
      {
        "pinned": false,
        "trace": [
          "meta-down -> hidden",
          "pointer-enter-token -> shown",
          "card-enter -> shown",
          "card-leave -> shown",
        ],
        "visible": true,
      }
    `);
  });

  it("reduces purely: the same state and event always give the same next state", () => {
    const once = inspectorNext(INSPECTOR_HIDDEN, "meta-down");
    expect(inspectorNext(once, "pointer-enter-token")).toEqual(inspectorNext(once, "pointer-enter-token"));
    expect(INSPECTOR_HIDDEN).toEqual({ visible: false, pinned: false, metaHeld: false, insideCard: false });
  });
});
