import { describe, expect, it } from "vitest";
import { registerPlugin, getPanelInstance, panelInstanceForId, dockComponents } from "./plugin";

describe("plugin panel instances", () => {
  it("registers an instance definition by kind and full panel id", () => {
    const component = () => null;
    registerPlugin({
      id: "instance-test-registration",
      panels: [],
      instances: [
        {
          id: "instance-test",
          prefix: "instance-test:",
          componentName: "instance-test-component",
          component,
        },
      ],
    });

    expect(getPanelInstance("instance-test")).toMatchInlineSnapshot(`
      {
        "component": [Function],
        "componentName": "instance-test-component",
        "id": "instance-test",
        "prefix": "instance-test:",
      }
    `);
    expect(panelInstanceForId("instance-test:%2Ftmp%2Fone")).toBe(getPanelInstance("instance-test"));
    expect(panelInstanceForId("other:%2Ftmp%2Fone")).toBeUndefined();
  });

  it("adds registered instance components to the Dockview component registry", () => {
    expect(dockComponents()["instance-test-component"]).toEqual(expect.any(Function));
  });
});
