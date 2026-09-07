// The shared tag prompt's two reads: recent five when nothing is typed, the tag
// table when something is, and the apply that hangs a note's tags on a source.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
const askText = vi.fn<(placeholder: string, initial?: string, options?: unknown) => Promise<string | null>>();

vi.mock("./generated/native", () => ({ invoke: (c: string, a?: unknown) => invoke(c, a) }));
vi.mock("./state", () => ({ store: { get: () => ({ aiFavs: [] }), set: vi.fn() } }));
vi.mock("./reactdock", () => ({ addPreviewPanel: vi.fn() }));
vi.mock("./plugin", () => ({ registerPlugin: vi.fn() }));
vi.mock("./tablepanels", () => ({ FavoritesPanelV2: {}, setFavoritesPanel: vi.fn() }));
vi.mock("./core", () => ({
  escapeHtml: (s: string) => s,
  baseName: (p: string) => p,
  flashStatus: vi.fn(),
  askText: (p: string, i?: string, o?: unknown) => askText(p, i, o),
}));
vi.mock("./preview", () => ({ previewInsts: new Map() }));
vi.mock("./terminal", () => ({ tabs: new Map(), tabMetaById: vi.fn(), tabCwds: vi.fn(() => []) }));
vi.mock("./worktrees", () => ({ openWorktree: vi.fn(), resumeLaunch: vi.fn(), sessionsForWorktree: vi.fn() }));
vi.mock("./harness", () => ({ harnessAdapter: vi.fn(), harnessesForCommand: vi.fn(() => []) }));
vi.mock("./0a_terminalSessionCandidates", () => ({ boundSessionFirst: vi.fn((s: unknown) => s) }));
vi.mock("./0_settings", () => ({ settings: { resumeTabs: { $: () => ({}) }, active: { $: () => null } } }));

const { applyTags, askTags, tagSuggest } = await import("./favorites");

beforeEach(() => {
  invoke.mockReset();
  askText.mockReset();
});

describe("tagSuggest", () => {
  it("offers the recent five when nothing is typed", async () => {
    invoke.mockResolvedValue([{ tag: "rust" }, { tag: "perf" }]);
    expect(await tagSuggest("  ")).toEqual(["rust", "perf"]);
    expect(invoke.mock.calls[0]).toEqual(["boop_tags_recent", { limit: 5 }]);
  });

  it("searches the tag table once something is typed", async () => {
    invoke.mockResolvedValue([{ tag: "rust" }]);
    expect(await tagSuggest("ru")).toEqual(["rust"]);
    expect(invoke.mock.calls[0]).toEqual(["boop_tags_search", { query: "ru", limit: 8 }]);
  });

  it("offers nothing when the read fails", async () => {
    invoke.mockRejectedValue(new Error("no db"));
    expect(await tagSuggest("")).toEqual([]);
  });
});

describe("askTags", () => {
  it("opens the shared prompt in multi mode over the tag source", async () => {
    askText.mockResolvedValue("perf, rust");
    expect(await askTags("tags for this turn")).toBe("perf, rust");
    expect(askText.mock.calls[0]![0]).toBe("tags for this turn");
    expect(askText.mock.calls[0]![2]).toEqual({ suggest: tagSuggest, multi: true });
  });
});

describe("applyTags", () => {
  it("hangs every tag in the note on the source", async () => {
    invoke.mockResolvedValue(["perf", "rust"]);
    expect(await applyTags("perf, rust", "comment:9")).toEqual(["perf", "rust"]);
    expect(invoke.mock.calls[0]).toEqual(["boop_tags_apply", { note: "perf, rust", source: "comment:9" }]);
  });

  it("reads nothing for an empty note", async () => {
    expect(await applyTags("  ", "comment:9")).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });
});
