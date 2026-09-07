import { describe, expect, it, vi } from "vitest";

const openExternal = vi.fn();
const addPreviewPanel = vi.fn();

vi.mock("./reactdock", () => ({
  addPreviewPanel: (...a: unknown[]) => addPreviewPanel(...a),
  allPanelIds: () => [],
  isPreviewOpen: () => false,
  activatePreviewPanel: vi.fn(),
  focusPanelById: vi.fn(),
  onDockChange: vi.fn(),
  panelVisibility$: vi.fn(),
  previewPanelId: (p: string) => `preview:${p}`,
  setPreviewRehydration: vi.fn(),
  togglePanel: vi.fn(),
}));
vi.mock("./plugin", () => ({ routePath: vi.fn(() => null) }));
vi.mock("./pluginState", () => ({ savePluginState: vi.fn() }));
vi.mock("./fsWatch", () => ({ claimFsWatch: vi.fn() }));
vi.mock("./generated/native", () => ({ invoke: vi.fn() }));
vi.mock("./0_openExternal", () => ({
  openExternal: (p: string) => openExternal(p),
  openExternalUrl: vi.fn(),
  revealExternal: vi.fn(),
}));
vi.mock("./1_FileImageViewer", () => ({ FileImageViewer: () => null }));
vi.mock("@hafley66/md", () => ({ renderD2: vi.fn() }));
vi.mock("./0_d2Preview", () => ({ resolveD2Preview: vi.fn() }));
vi.mock("./0_MonacoCodeViewer", () => ({ MonacoCodeViewer: () => null }));
vi.mock("./0_settings", () => ({
  settings: { mode: { $: () => "dark", $$: vi.fn() } },
}));

// Repo convention (vitest.config.ts): stub the browser globals the import
// chain reads at module load rather than pulling in jsdom.
vi.stubGlobal("location", { search: "", hash: "" });
vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });

const { openPathInInstant } = await import("./preview");

describe("openPathInInstant", () => {
  it("sends a video to the OS default app and opens no preview panel", async () => {
    await openPathInInstant("/x/clip.mp4");
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith("/x/clip.mp4");
    expect(addPreviewPanel).not.toHaveBeenCalled();
  });
});
