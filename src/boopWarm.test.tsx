/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Observable, NEVER } from "rxjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { GRAPH } = vi.hoisted(() => ({
  GRAPH: {
    schema_version: 1,
    sessions: [],
    edges: [],
    shells: [
      {
        lane: "feat-alpha",
        parent_lane: null,
        harness: "opencode",
        mode: "auto",
        session_id: null,
        session: null,
        cwd: "/repo/a",
        tmux: "feat-alpha",
        pid: 11,
        state: "live",
        started_ts: 1000,
      },
      {
        lane: "fix-beta",
        parent_lane: "feat-alpha",
        harness: "codex",
        mode: "auto",
        session_id: null,
        session: null,
        cwd: "/repo/b",
        tmux: "fix-beta",
        pid: 22,
        state: "dead",
        started_ts: 2000,
      },
    ],
  },
}));

// 0_settings reads location/storage at import time; the hoisted stub runs
// before the import graph evaluates.
vi.hoisted(() => {
  const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  globalThis.location = { search: "", hash: "" } as unknown as Location;
  globalThis.localStorage = storage as unknown as Storage;
  globalThis.sessionStorage = storage as unknown as Storage;
});

// The real native transport reaches for Tauri IPC or a loopback WebSocket;
// the test replaces it with a counted stub so backend reads are observable.
vi.mock("./reactive/nativeTransport", () => {
  return {
    nativeCommandUrl: (command: string) => `tauri://instant/commands/${encodeURIComponent(command)}`,
    nativeRequestTransport: async () => {
      warmInvokes.count++;
      return { status: 200, body: GRAPH };
    },
    listenNativeEvent: () => new Promise(() => {}),
    nativeEvent$: () => NEVER,
  };
});

const warmInvokes = { count: 0 };

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

import { graphQuery, resetBoopGraphWarmForTest, warmBoopGraph } from "./boopPanel";

describe("boop graph warm pin", () => {
  beforeEach(() => resetBoopGraphWarmForTest());

  it("registers one subscription; the second warm call is a no-op", () => {
    let subscriptions = 0;
    const counting$ = new Observable<unknown>(() => {
      subscriptions++;
      return () => {};
    });
    warmBoopGraph(counting$);
    warmBoopGraph(counting$);
    expect(subscriptions).toBe(1);
  });

  it("warming the real query pulls the graph before the panel mounts, and arrival replays it", async () => {
    warmBoopGraph();
    await act(async () => {
      await vi.waitFor(() => expect(graphQuery.$().data).toBeDefined());
    });
    const afterWarm = warmInvokes.count;
    expect(afterWarm).toBeGreaterThan(0);

    const host = document.createElement("div");
    const root = createRoot(host);
    // The panel's read shape (useSignal(graphQuery.$)): the already-warm query
    // replays the last state, so the first paint renders rows without waiting
    // for a fetch.
    const BoopGraphReader = () => (
      <output data-testid="lanes">
        {(graphQuery.$().data?.shells ?? []).map((shell) => shell.lane).join(",")}
      </output>
    );
    await act(async () => root.render(<BoopGraphReader />));
    expect(host.textContent).toBe("feat-alpha,fix-beta");
    expect(warmInvokes.count).toBe(afterWarm);
    await act(async () => root.unmount());
  });
});
