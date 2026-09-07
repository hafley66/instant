// The tag source and the panel search that reads a favorite's note.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();

vi.mock("./generated/native", () => ({ invoke: (c: string, a?: unknown) => invoke(c, a) }));
vi.mock("./state", () => ({ store: { get: () => ({ aiFavs: [] }), set: vi.fn() } }));
vi.mock("./reactdock", () => ({ addPreviewPanel: vi.fn() }));
vi.mock("./plugin", () => ({ registerPlugin: vi.fn() }));
vi.mock("./tablepanels", () => ({ FavoritesPanelV2: {}, setFavoritesPanel: vi.fn() }));
vi.mock("./core", () => ({ escapeHtml: (s: string) => s, baseName: (p: string) => p, flashStatus: vi.fn() }));
vi.mock("./preview", () => ({ previewInsts: new Map() }));
vi.mock("./terminal", () => ({ tabs: new Map(), tabMetaById: vi.fn(), tabCwds: vi.fn(() => []) }));
vi.mock("./worktrees", () => ({ openWorktree: vi.fn(), resumeLaunch: vi.fn(), sessionsForWorktree: vi.fn() }));
vi.mock("./harness", () => ({ harnessAdapter: vi.fn(), harnessesForCommand: vi.fn(() => []) }));
vi.mock("./0a_terminalSessionCandidates", () => ({ boundSessionFirst: vi.fn((s: unknown) => s) }));
vi.mock("./0_settings", () => ({ settings: { resumeTabs: { $: () => ({}) }, active: { $: () => null } } }));

const { noteTags } = await import("./favorites");

beforeEach(() => {
  invoke.mockReset();
});

describe("noteTags", () => {
  it("reads every note already in use", async () => {
    invoke.mockResolvedValue(["a", "b"]);
    expect(await noteTags()).toEqual(["a", "b"]);
    expect(invoke.mock.calls[0]![0]).toBe("boop_note_tags");
  });

  it("offers nothing when the read fails", async () => {
    invoke.mockRejectedValue(new Error("no db"));
    expect(await noteTags()).toEqual([]);
  });
});
