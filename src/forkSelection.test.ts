/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";

const runClick = vi.fn<(args: { command: string; cwd: string }) => Promise<string>>();
const sendSelection = vi.fn<(item: { note?: string }) => Promise<number>>();
const askText = vi.fn<(placeholder: string) => Promise<string | null>>();
const flashed: string[] = [];

vi.mock("./ipc/contract", () => ({ clickRpc: { runClick: (a: never) => runClick(a) } }));
vi.mock("./generated/native", () => ({ commands: { boop: {} }, invoke: vi.fn() }));
vi.mock("./state", () => ({ store: { get: () => ({ sessions: [], aiFavs: [] }), set: vi.fn() }, SAFE_BOOT: false }));
vi.mock("./0_settings", () => ({
  settings: {
    openTabs: { $: () => [] },
    active: { $: () => "t1" },
    resumeTabs: { $: () => ({}) },
    inlineStructuredSelectors: { $: () => false },
    favExpanded: { $: () => [] },
  },
}));
vi.mock("./core", () => ({
  sessionId: () => "s1",
  activeId: () => "t1",
  setActive: vi.fn(),
  flashStatus: (msg: string) => { flashed.push(msg); },
  showError: vi.fn(),
  sanitizePaste: (s: string) => s,
  escapeHtml: (s: string) => s,
  askText: (p: string) => askText(p),
  THEMES: {},
  termFontFamily: () => "",
}));
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("./graphics", () => ({ GraphicsOverlay: class {} }));
vi.mock("./0_terminalDiagrams", () => ({ TerminalDiagramOverlay: class {} }));
vi.mock("./1_terminalStructuredOverlay", () => ({ TerminalStructuredOverlay: class {} }));
vi.mock("./0_turnDebugOverlay", () => ({ TerminalTurnDebugOverlay: class {} }));
vi.mock("./0_turnDebugSettings", () => ({ turnDebug: {} }));
vi.mock("./00b_terminalLineAnchors", () => ({ TerminalLineAnchors: class {} }));
vi.mock("./1a_terminalContextQueue", () => ({ TerminalContextQueue: class {} }));
vi.mock("./1b_terminalContextSync", () => ({ TerminalContextSync: class {} }));
vi.mock("./1c_terminalHoverCheck", () => ({ TerminalHoverCheck: class {} }));
vi.mock("./1d_terminalTurnMarks", () => ({ TerminalTurnMarks: class {} }));
vi.mock("./0_forkRenderSettings", () => ({ forkRender: { livePane: { $: () => false }, lastPreset: { $: vi.fn() } } }));
vi.mock("./1g_forkPresetMenu", () => ({ currentForkPreset: vi.fn(), forkPresetStore: {}, forkPresets: vi.fn(), presetGroups: vi.fn() }));
vi.mock("./ctxmenu", () => ({ showContextMenu: vi.fn() }));
vi.mock("./0_terminalWheel", () => ({ TerminalWheelRouter: class {} }));
vi.mock("./0_terminalPinnedSelection", () => ({ TerminalPinnedSelection: class {} }));
vi.mock("./keymap", () => ({ runMatchingCommand: vi.fn() }));
vi.mock("./reactdock", () => ({ addTermPanel: vi.fn(), focusTermPanel: vi.fn(), removeTermPanel: vi.fn(), hasTermPanel: vi.fn(), activePanelId: vi.fn(), activePanelChangedTime: vi.fn(), termPanelId: vi.fn() }));
vi.mock("./clickrules", () => ({ cmdClickRouter: {}, dispatchClick: vi.fn(), clickIntent: vi.fn(), resolveReference: vi.fn() }));
vi.mock("./0_openExternal", () => ({ openExternal: vi.fn(), revealExternal: vi.fn() }));
vi.mock("./termTokens", () => ({ tokenAtColumn: vi.fn(), widenAcrossSpaces: vi.fn() }));
vi.mock("./termWrapJoin", () => ({ joinWrappedRows: vi.fn(), capWrappedRows: vi.fn(), softWrappedPathLink: vi.fn(), wrappedLinkSpans: vi.fn(), MAX_WRAP_ROWS: 0 }));
vi.mock("./refResolve", () => ({ resolveRef: vi.fn() }));
vi.mock("./promptQuote", () => ({ bracketedPaste: vi.fn() }));
vi.mock("./panelZoom", () => ({ registerZoomKind: vi.fn(), setZoomTargetResolver: vi.fn(), setChromeZoom: vi.fn(), resolveZoomTarget: vi.fn(), panelZoomGesture: vi.fn(), panelZoomResetGesture: vi.fn(), zoomFactorFor: vi.fn() }));
vi.mock("./overlay", () => ({ nudgeZoom: vi.fn(), resetZoom: vi.fn() }));
vi.mock("./inlinePreview", () => ({ inlineSnippetHtml: vi.fn() }));
vi.mock("./preview", () => ({ openPreviewPanel: vi.fn() }));
vi.mock("./browser", () => ({ browserTabs: {} }));
vi.mock("./favorites", () => ({ boopCandidateTurns: vi.fn(), boopTurnsForSession: vi.fn(), boopTurnsForTab: vi.fn(), invalidateBoopTurns: vi.fn(), sessionsForTab: vi.fn(), warmTurns: vi.fn() }));
vi.mock("./0_terminalTurnVisibility", () => ({ selectProjectionTurns: vi.fn(), TerminalTurnVisibilityV2: class {} }));
vi.mock("./00a_terminalIntersection", () => ({ NativeTmuxPane: class {}, XtermViewportAdapter: class {} }));
vi.mock("./0_clickRouter", () => ({ CmdClickGestureTracker: class {} }));
vi.mock("./0_inspectorState", () => ({ InspectorMachine: class {} }));
vi.mock("./0_reopenOrder", () => ({ nextClosedOrder: vi.fn() }));
vi.mock("./tabs", () => ({ tabTitle: vi.fn(), reflowPinnedTabs: vi.fn() }));
vi.mock("./harness", () => ({ detectHarness: vi.fn(), trimOutputTail: vi.fn() }));
vi.mock("./0_externalShells", () => ({ externalShellOpenSessionArgs: vi.fn(), externalViewerTarget: vi.fn(), viewerFailureAction: vi.fn(), viewerNeedsRetarget: vi.fn() }));
vi.mock("./worktrees", () => ({ renderSessionActive: vi.fn(), refreshSessions: vi.fn() }));

const { forkSelection, forkSelectionWithNote, tabs } = await import("./terminal");

const fakeTab = () => ({
  name: "tab-1",
  harness: { id: "opencode" },
  term: {
    getSelection: () => "selected text",
    clearSelection: vi.fn(),
    buffer: { active: { viewportY: 0 } },
    rows: 24,
  },
  contextQueue: {
    snapshotFor: (text: string) => ({ text, turnIds: ["sess-a:3"] }),
  },
  contextSync: {
    sendSelection: sendSelection,
    activate: vi.fn(),
  },
  pinnedSelection: undefined,
});

beforeEach(() => {
  flashed.length = 0;
  runClick.mockReset();
  sendSelection.mockReset();
  askText.mockReset();
  runClick.mockResolvedValue("forked comment 47 -> lane fork-comment-47");
  sendSelection.mockResolvedValue(47);
  askText.mockResolvedValue(null);
  tabs.clear();
  tabs.set("t1", fakeTab() as never);
});

describe("forkSelection", () => {
  it("carries a trimmed note to the stored row", async () => {
    await forkSelection("t1", "flash4", " do X ");
    expect(sendSelection).toHaveBeenCalledTimes(1);
    expect((sendSelection.mock.calls[0]![0] as { note?: string }).note).toBe("do X");
  });

  it("leaves the note undefined when none is given", async () => {
    await forkSelection("t1", "flash4");
    expect((sendSelection.mock.calls[0]![0] as { note?: string }).note).toBeUndefined();
  });
});

describe("forkSelectionWithNote", () => {
  it("forks with no note when the prompt resolves null, never cancels", async () => {
    askText.mockResolvedValue(null);
    await forkSelectionWithNote("t1", "flash4");
    expect(askText).toHaveBeenCalledTimes(1);
    expect(runClick).toHaveBeenCalledTimes(1);
    expect((sendSelection.mock.calls[0]![0] as { note?: string }).note).toBeUndefined();
  });

  it("forks with the typed note when one is given", async () => {
    askText.mockResolvedValue("do this");
    await forkSelectionWithNote("t1", "flash4");
    expect((sendSelection.mock.calls[0]![0] as { note?: string }).note).toBe("do this");
  });
});
