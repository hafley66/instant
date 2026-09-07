import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
const flashed: string[] = [];

vi.mock("./generated/native", () => ({ invoke: (c: string, a?: unknown) => invoke(c, a) }));
vi.mock("./state", () => ({ store: { get: () => ({ aiFavs: [] }), set: vi.fn() } }));
vi.mock("./reactdock", () => ({ addPreviewPanel: vi.fn() }));
vi.mock("./plugin", () => ({ registerPlugin: vi.fn() }));
vi.mock("./tablepanels", () => ({ FavoritesPanelV2: {}, setFavoritesPanel: vi.fn() }));
vi.mock("./core", () => ({ escapeHtml: (s: string) => s, baseName: (p: string) => p, flashStatus: (m: string) => { flashed.push(m); } }));
vi.mock("./preview", () => ({ previewInsts: new Map() }));
vi.mock("./terminal", () => ({ tabs: new Map(), tabMetaById: vi.fn(), tabCwds: vi.fn(() => []) }));
vi.mock("./worktrees", () => ({ openWorktree: vi.fn(), resumeLaunch: vi.fn(), sessionsForWorktree: vi.fn() }));
vi.mock("./harness", () => ({ harnessAdapter: vi.fn(), harnessesForCommand: vi.fn(() => []) }));
vi.mock("./0a_terminalSessionCandidates", () => ({ boundSessionFirst: vi.fn((s: unknown) => s) }));
vi.mock("./0_settings", () => ({ settings: { resumeTabs: { $: () => ({}) }, active: { $: () => null } } }));

const { favoriteBoopTurn } = await import("./favorites");
import type { BoopTurn } from "./0_terminalTurnVisibility";

const turn: BoopTurn = { session: "sess-a", harness: "opencode", turn: 3, ts: 1, role: "assistant", said: "hi" };

beforeEach(() => {
  flashed.length = 0;
  invoke.mockReset();
  invoke.mockResolvedValue([]);
});

describe("favoriteBoopTurn", () => {
  it("hands a typed note through to the toggle command", async () => {
    await favoriteBoopTurn(turn, "why");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]![0]).toBe("boop_favorite_toggle");
    expect(invoke.mock.calls[0]![1]).toEqual({ turn, note: "why" });
  });

  it("falls back to an empty note when none is given", async () => {
    await favoriteBoopTurn(turn);
    expect(invoke.mock.calls[0]![1]).toEqual({ turn, note: "" });
  });
});
