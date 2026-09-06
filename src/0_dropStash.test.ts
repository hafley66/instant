import { describe, it, expect, vi, beforeEach } from "vitest";

const runClick = vi.fn<(args: { command: string; cwd: string }) => Promise<string>>();
const written: string[] = [];
const logged: string[] = [];
const flashed: string[] = [];
const focus = vi.fn();
const openTabs = new Map<string, unknown>();

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({}) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ WebviewWindow: { getByLabel: async () => null } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/dpi", () => ({ PhysicalPosition: class {}, PhysicalSize: class {} }));
vi.mock("./terminal", () => ({
  tabs: openTabs,
  pasteToActive: (data: string) => written.push(data),
}));
vi.mock("./capture", () => ({ cancelHide: vi.fn() }));
vi.mock("./sprefa", () => ({ addScope: vi.fn() }));
vi.mock("./ipc/contract", () => ({ clickRpc: { runClick: (a: never) => runClick(a) } }));
vi.mock("./core", () => ({
  activeId: () => "t1",
  pathArg: (p: string) => (/\s/.test(p) ? `'${p.replace(/'/g, "'\\''")}'` : p),
  IMAGE_EXTS: new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif", "tif", "tiff", "heic"]),
  logLine: (line: string) => logged.push(line),
  flashStatus: (msg: string) => flashed.push(msg),
}));

const { dropIntoTerminal } = await import("./dnd");
const { pasteFailure, dropLogLine, pathExt, dropPath } = await import("./0_dropStash");

const STASHED = "/Users/me/.agent/drops/20260905-234058-Screenshot-2026-09-05-at-11.40.58-PM.png";
const SOURCE = "/var/folders/x/T/TemporaryItems/NSIRD_screencaptureui_1fMIW1/Screenshot 2026-09-05 at 11.40.58 PM.png";
const drop = (over: Partial<{ source: string; stashed: string | null; bytes: number; reason: string | null }> = {}) => ({
  source: SOURCE,
  stashed: STASHED,
  bytes: 84_211,
  reason: null,
  ...over,
});

beforeEach(() => {
  written.length = 0;
  logged.length = 0;
  flashed.length = 0;
  openTabs.clear();
  openTabs.set("t1", { tmuxTarget: "%12", term: { focus } });
  runClick.mockReset();
  runClick.mockResolvedValue(`pasted ${STASHED} as PNGf into %12: pasteboard + C-v`);
});

describe("dropIntoTerminal", () => {
  it("pastes the stashed copy, never the vanished promise file", async () => {
    await dropIntoTerminal("t1", [STASHED], [drop()]);
    expect(runClick).toHaveBeenCalledTimes(1);
    const { command } = runClick.mock.calls[0]![0];
    expect(command).toContain("boop beep paste --pane %12");
    expect(command).toContain(STASHED);
    expect(command).not.toContain("TemporaryItems");
    expect(written).toEqual([]);
    expect(logged[0]).toContain("outcome=pasted");
    expect(logged[0]).toContain(`bytes=84211`);
  });

  it("types a non-image and leaves boop out of it", async () => {
    await dropIntoTerminal("t1", ["/Users/me/notes.txt"], [
      drop({ source: "/Users/me/notes.txt", stashed: null, bytes: 12, reason: "not an image" }),
    ]);
    expect(runClick).not.toHaveBeenCalled();
    expect(written).toEqual(["/Users/me/notes.txt "]);
    expect(logged[0]).toContain("outcome=typed");
    expect(logged[0]).toContain('reason="not an image"');
  });

  it("types the stashed path and toasts boop's reason when the paste fails", async () => {
    runClick.mockResolvedValue("Error: pane %12 does not exist");
    await dropIntoTerminal("t1", [STASHED], [drop()]);
    expect(written).toEqual([`${STASHED} `]);
    expect(flashed).toEqual(["paste failed: pane %12 does not exist"]);
    expect(logged[0]).toContain("typed after paste failed");
  });

  it("uses the wider IMAGE_EXTS table, not the old png/jpg/gif/tif/bmp regex", async () => {
    await dropIntoTerminal("t1", ["/Users/me/a.webp", "/Users/me/b.heic"], []);
    expect(runClick).toHaveBeenCalledTimes(2);
  });

  it("types everything when the tab has no tmux pane", async () => {
    openTabs.set("t1", { term: { focus } });
    await dropIntoTerminal("t1", [STASHED], [drop()]);
    expect(runClick).not.toHaveBeenCalled();
    expect(written).toEqual([`${STASHED} `]);
  });
});

describe("stash helpers", () => {
  it("reads boop's one-line verdict", () => {
    expect(pasteFailure("pasted /a.png as PNGf into %12: pasteboard + C-v")).toBe("");
    expect(pasteFailure("typed /a.svg into %12 (no Enter)")).toBe("");
    expect(pasteFailure("Error: /a.png does not exist")).toBe("/a.png does not exist");
    expect(pasteFailure("")).toBe("boop beep paste said nothing");
  });

  it("names the stashed copy once there is one", () => {
    expect(dropPath(drop())).toBe(STASHED);
    expect(dropPath(drop({ stashed: null }))).toBe(SOURCE);
    expect(pathExt("/a/b/Screenshot 1.PNG")).toBe("png");
    expect(pathExt("/a/promise-file")).toBe("");
  });

  it("logs one line per drop", () => {
    expect(dropLogLine(drop(), "pasted")).toBe(
      `drop source=${JSON.stringify(SOURCE)} stashed=${JSON.stringify(STASHED)} bytes=84211 outcome=pasted`,
    );
  });
});
