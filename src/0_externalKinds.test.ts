import { describe, expect, it, vi } from "vitest";

vi.mock("./reactdock", () => ({ activeGroupEl: vi.fn() }));
vi.mock("./generated/native", () => ({ invoke: vi.fn() }));
vi.mock("./0_terminalFonts", () => ({ terminalFontCss: vi.fn(() => "") }));
vi.mock("./0_settings", () => ({ settings: {} }));

// Repo convention (vitest.config.ts): stub the browser globals core.ts's
// import chain reads at module load rather than pulling in jsdom.
vi.stubGlobal("location", { search: "", hash: "" });
vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });

const { EXTERNAL_EXTS, opensExternally, isKnownInstantKind } = await import("./0_externalKinds");

describe("external kinds", () => {
  it.each([
    ["/m/clip.mp4", true, false, "video"],
    ["/m/tune.mp3", true, false, "audio"],
    ["/m/bundle.zip", true, false, "archive"],
    ["/m/paper.docx", true, false, "office document"],
    ["/m/Face.ttf", true, false, "font"],
    ["/m/Tool.app", true, false, "application"],
    ["/m/CLIP.MOV", true, false, "uppercase extension still matches"],
    ["/m/LICENSE", false, false, "no extension stays inside"],
    ["/m/readme.md", false, true, "markdown renders"],
    ["/m/main.rs", false, true, "language-table source renders"],
    ["/m/logo.png", false, true, "image renders"],
    ["/m/index.html", false, true, "html routes to the browser tab"],
  ] as const)("%s -> external=%s known=%s (%s)", (path, external, known, _label) => {
    expect(opensExternally(path)).toBe(external);
    expect(isKnownInstantKind(path)).toBe(known);
  });

  it("EXTERNAL_EXTS holds every group", () => {
    expect(EXTERNAL_EXTS.has("webm")).toBe(true);
    expect(EXTERNAL_EXTS.has("ogg")).toBe(true);
    expect(EXTERNAL_EXTS.has("dmg")).toBe(true);
    expect(EXTERNAL_EXTS.has("key")).toBe(true);
    expect(EXTERNAL_EXTS.has("woff2")).toBe(true);
  });
});
