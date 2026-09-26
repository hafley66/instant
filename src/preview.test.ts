import { beforeEach, describe, expect, it, vi } from "vitest";

const openExternal = vi.fn();
const addPreviewPanel = vi.fn();
const openBrowserTab = vi.fn();

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
vi.mock("@hafley66/md", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hafley66/md")>()),
  renderD2: vi.fn(),
  resolveD2Preview: vi.fn(),
}));
vi.mock("./0_MonacoCodeViewer", () => ({ MonacoCodeViewer: () => null }));
vi.mock("./browser", () => ({ openBrowserTab: (...a: unknown[]) => openBrowserTab(...a) }));
vi.mock("./0_settings", () => ({
  settings: { mode: { $: () => "dark", $$: vi.fn() } },
}));

// Repo convention (vitest.config.ts): stub the browser globals the import
// chain reads at module load rather than pulling in jsdom.
vi.stubGlobal("location", { search: "", hash: "" });
vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });

const { openPathInInstant } = await import("./preview");
const { invoke } = await import("./generated/native");
const { setHomeDir } = await import("./core");

describe("openPathInInstant", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setHomeDir("/Users/test");
  });

  it("sends a video to the OS default app and opens no preview panel", async () => {
    await openPathInInstant("/x/clip.mp4");
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith("/x/clip.mp4");
    expect(addPreviewPanel).not.toHaveBeenCalled();
  });

  it("probes the expanded path for generated docs, then falls through to the file browser", async () => {
    (invoke as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await openPathInInstant("~/target/doc/crate/index.html");
    // The backend never sees a raw `~/`: the probe and the file URL agree.
    expect(invoke).toHaveBeenCalledWith("rustdoc_open", {
      path: "/Users/test/target/doc/crate/index.html",
    });
    expect(openBrowserTab).toHaveBeenCalledWith("file:///Users/test/target/doc/crate/index.html");
  });

  it("opens the loopback URL when the backend maps a generated page", async () => {
    (invoke as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      "http://127.0.0.1:5555/target/doc/crate/index.html",
    );
    await openPathInInstant("~/target/doc/crate/index.html");
    expect(openBrowserTab).toHaveBeenCalledWith(
      "http://127.0.0.1:5555/target/doc/crate/index.html",
    );
  });

  it("opens a plain ~/ HTML file in the file browser", async () => {
    await openPathInInstant("~/papers/closure.html");
    expect(openBrowserTab).toHaveBeenCalledWith("file:///Users/test/papers/closure.html");
  });
});
