import { describe, it, expect, vi, beforeEach } from "vitest";

const setTitle = vi.fn();
const customTitle = vi.fn<(sid: string) => string | null>(() => null);
const openTabs = new Map<string, unknown>();
let pinned: string[] = [];

vi.mock("./reactdock", () => ({
  setTermTitle: (sid: string, title: string) => setTitle(sid, title),
  customTermTitle: (sid: string) => customTitle(sid),
  moveTermPanel: vi.fn(),
  allPanelIds: () => [],
  activePanelId: () => null,
  focusPanelById: vi.fn(),
  closeActivePanel: vi.fn(),
  reopenClosedPanel: vi.fn(),
  latestClosedPanel: () => null,
}));
vi.mock("./terminal", () => ({
  tabs: openTabs,
  openTab: vi.fn(),
  closedTabs: new Map(),
  settleClosures: vi.fn(),
}));
vi.mock("./worktrees", () => ({
  refreshSessions: vi.fn(),
  resumeIdIsLive: vi.fn(),
  resumeLaunch: vi.fn(),
  dropResumeTab: vi.fn(),
}));
vi.mock("./0_settings", () => ({
  settings: { pinnedTabs: { $: () => pinned } },
}));
vi.mock("./generated/native", () => ({
  invoke: (command: string, args: Record<string, unknown>) => {
    renamed.push([command, args]);
    return Promise.resolve();
  },
}));

const renamed: [string, Record<string, unknown>][] = [];

// Repo convention (vitest.config.ts): stub the few browser globals a module
// reads at import time rather than pulling in jsdom.
vi.stubGlobal("location", { search: "", hash: "" });
vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });

const { store } = await import("./state");
const { sessionId } = await import("./core");
const { tabTitle, syncTabTitlesFromTmux, applyTabTitle } = await import("./tabs");

type SessionPatch = { name: string; title: string };
const liveSessions = (rows: SessionPatch[]) =>
  store.set({
    sessions: rows.map((r) => ({
      ...r,
      windows: 1,
      attached: true,
      activity: 0,
      created: 0,
      paths: [],
      commands: [],
    })),
  });

beforeEach(() => {
  setTitle.mockClear();
  customTitle.mockReset().mockReturnValue(null);
  openTabs.clear();
  pinned = [];
  renamed.length = 0;
  store.set({ sessions: [] });
});

describe("tab titles follow tmux", () => {
  it("shows what tmux shows for the session", () => {
    liveSessions([{ name: "projects-3", title: "✳ Chat log scrollback" }]);
    expect(tabTitle("projects-3")).toBe("✳ Chat log scrollback");
  });

  it("keeps the session name when tmux reports nothing worth showing", () => {
    liveSessions([{ name: "projects", title: "" }]);
    expect(tabTitle("projects")).toBe("projects");
  });

  it("lets a manual rename outrank tmux", () => {
    liveSessions([{ name: "projects", title: "✳ Boop agents recovery" }]);
    customTitle.mockReturnValue("my tab");
    expect(tabTitle("projects")).toBe("my tab");
  });

  it("composes the pin prefix on top of the tmux title", () => {
    liveSessions([{ name: "projects", title: "✳ Boop agents recovery" }]);
    pinned = ["projects"];
    expect(tabTitle("projects")).toBe("📌 ✳ Boop agents recovery");
  });

  it("republishes only the open tabs whose title moved", () => {
    openTabs.set(sessionId("projects"), {});
    liveSessions([
      { name: "projects", title: "first" },
      { name: "not-open", title: "ignored" },
    ]);
    syncTabTitlesFromTmux();
    expect(setTitle.mock.calls).toEqual([[sessionId("projects"), "first"]]);

    setTitle.mockClear();
    syncTabTitlesFromTmux();
    expect(setTitle).not.toHaveBeenCalled();

    liveSessions([{ name: "projects", title: "second" }]);
    syncTabTitlesFromTmux();
    expect(setTitle.mock.calls).toEqual([[sessionId("projects"), "second"]]);
  });

  it("hands a rename to tmux and a clear back to automatic-rename", () => {
    liveSessions([{ name: "projects", title: "agent set this" }]);
    applyTabTitle("projects");
    expect(renamed).toEqual([]); // boot with no override must not clear tmux

    customTitle.mockReturnValue("my tab");
    applyTabTitle("projects");
    expect(renamed).toEqual([["rename_session_window", { name: "projects", title: "my tab" }]]);

    applyTabTitle("projects");
    expect(renamed).toHaveLength(1); // unchanged override stays off the wire

    customTitle.mockReturnValue(null);
    applyTabTitle("projects");
    expect(renamed[1]).toEqual(["rename_session_window", { name: "projects", title: "" }]);
  });

  it("keeps a pin toggle off the tmux wire", () => {
    liveSessions([{ name: "projects", title: "agent set this" }]);
    customTitle.mockReturnValue("my tab");
    applyTabTitle("projects");
    renamed.length = 0;
    pinned = ["projects"];
    applyTabTitle("projects");
    expect(renamed).toEqual([]);
  });

  it("does not re-publish a title applyTabTitle already pushed", () => {
    openTabs.set(sessionId("projects"), {});
    liveSessions([{ name: "projects", title: "same" }]);
    applyTabTitle("projects");
    setTitle.mockClear();
    syncTabTitlesFromTmux();
    expect(setTitle).not.toHaveBeenCalled();
  });
});
