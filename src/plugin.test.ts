import { describe, expect, it } from "vitest";
import {
  dockComponents,
  getPanelInstance,
  panelInstanceForId,
  pluginCommands,
  plugins,
  registerPlugin,
  routePath,
  tabOverrideItems,
} from "./plugin";

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

  it("retains commands, path routes, and tab overrides on the plugin manifest", () => {
    registerPlugin({
      id: "contribution-test-registration",
      panels: [],
      commands: [{ id: "contribution.test", keys: [], run: () => {} }],
      routes: [{ id: "contribution.route", open: (path) => path === "/tmp/contribution" }],
      tabOverrides: [
        {
          id: "contribution.tabs",
          matches: (panelId) => panelId === "contribution",
          items: () => [{ label: "contribution", action: () => {} }],
        },
      ],
    });

    expect(plugins().find((plugin) => plugin.id === "contribution-test-registration")).toMatchObject({
      id: "contribution-test-registration",
      commands: [{ id: "contribution.test" }],
      routes: [{ id: "contribution.route" }],
      tabOverrides: [{ id: "contribution.tabs" }],
    });
    expect(pluginCommands().some((command) => command.id === "contribution.test")).toBe(true);
    expect(routePath("/tmp/contribution")).toBe(true);
    expect(routePath("/tmp/other")).toBe(false);
    expect(tabOverrideItems("contribution").map((item) => item.label)).toEqual(["contribution"]);
  });
});
