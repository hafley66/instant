import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NativeTransport } from "./nativeTransport";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: { line?: string }) => Promise<void>>(() =>
    Promise.resolve(),
  ),
}));
vi.mock("../generated/native", () => ({ invoke }));

const { browserPorts, tauriPorts } = await import("./ports");
const { pickTransport } = await import("./nativeTransport");

// The stub ports log through the command table ("log_append", …); every other
// command reaching `invoke` would be a real backend call the browser cannot make.
const loggedLines = (): string[] =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === "log_append")
    .map(([, args]) => args?.line ?? "");
const nonLogCommands = (): string[] =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command !== "log_append")
    .map(([command]) => command);

function fakeTransport(): NativeTransport & { invoke: ReturnType<typeof vi.fn> } {
  return { invoke: vi.fn(), listen: vi.fn() } as unknown as NativeTransport & {
    invoke: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  invoke.mockClear();
});

describe("browserPorts", () => {
  it("resolves window and webview ops after one log line each", async () => {
    const { invoke: transportInvoke } = fakeTransport();
    const ports = browserPorts({ invoke: transportInvoke, listen: vi.fn() } as unknown as NativeTransport);
    await ports.window.hide();
    await ports.webview.setZoom(1.5);
    const lines = loggedLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("window.hide");
    expect(lines[1]).toContain("webview.setZoom");
    expect(transportInvoke).not.toHaveBeenCalled();
    expect(nonLogCommands()).toEqual([]);
  });

  it("falls back to one log line each for openPath/revealItemInDir/openUrl while no backend command exists", async () => {
    const { invoke: transportInvoke } = fakeTransport();
    const ports = browserPorts({ invoke: transportInvoke, listen: vi.fn() } as unknown as NativeTransport);
    await ports.openPath("/a/b.txt");
    await ports.revealItemInDir("/a/b.txt");
    await ports.openUrl("https://example.com");
    expect(transportInvoke).not.toHaveBeenCalled();
    expect(nonLogCommands()).toEqual([]);
    expect(loggedLines()).toHaveLength(3);
  });

  it("routes open(reveal) through revealItemInDir", async () => {
    const ports = browserPorts(fakeTransport() as unknown as NativeTransport);
    await ports.open({ label: "l", path: "/a/b.txt", reveal: true });
    expect(loggedLines()[0]).toContain("revealItemInDir");
  });

  it("findWindow resolves null so os-drop wiring stands down", async () => {
    const ports = browserPorts(fakeTransport() as unknown as NativeTransport);
    await expect(ports.findWindow("dropcatcher")).resolves.toBeNull();
  });

  it("homeDir resolves the empty string the boot path already treats as failure", async () => {
    const ports = browserPorts(fakeTransport() as unknown as NativeTransport);
    await expect(ports.homeDir()).resolves.toBe("");
  });

  it("onFocusChanged resolves an unlisten function", async () => {
    const ports = browserPorts(fakeTransport() as unknown as NativeTransport);
    const unlisten = await ports.window.onFocusChanged(() => {});
    expect(typeof unlisten).toBe("function");
  });
});

describe("pickTransport", () => {
  it("memoizes one ws transport per url and honors ?ws=", () => {
    vi.stubGlobal("location", { search: "?ws=ws://memo.test" });
    const memo = pickTransport();
    expect(pickTransport()).toBe(memo);
    vi.stubGlobal("location", { search: "?ws=ws://other.test" });
    expect(pickTransport()).not.toBe(memo);
  });

  it("uses the default url without a ws param", () => {
    vi.stubGlobal("location", { search: "" });
    expect(pickTransport()).toBe(pickTransport());
  });

  it("prefers tauri when __TAURI_INTERNALS__ is present", () => {
    vi.stubGlobal("location", { search: "" });
    const wsOne = pickTransport();
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    expect(pickTransport()).not.toBe(wsOne);
  });
});

describe("port parity", () => {
  it("exposes the same window/webview op surface from both implementations", () => {
    const tauri = tauriPorts();
    const browser = browserPorts(fakeTransport() as unknown as NativeTransport);
    expect(Object.keys(browser.window).sort()).toEqual(Object.keys(tauri.window).sort());
    expect(Object.keys(browser.webview).sort()).toEqual(Object.keys(tauri.webview).sort());
  });
});
