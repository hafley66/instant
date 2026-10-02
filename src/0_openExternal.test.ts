import { expect, it, vi } from "vitest";
import { openExternalUrl } from "./0_openExternal";
import { runtimePorts } from "./reactive/ports";

vi.mock("./reactive/ports", () => ({
  runtimePorts: { openUrl: vi.fn(), window: { hide: vi.fn(), show: vi.fn() } },
}));

it("waits for Chrome to accept the URL before hiding and leaves the window alone on rejection", async () => {
  const events: string[] = [];
  let accept!: () => void;
  vi.mocked(runtimePorts.openUrl).mockImplementation(() => new Promise<void>((resolve) => {
    events.push("open");
    accept = resolve;
  }));
  vi.mocked(runtimePorts.window.hide).mockImplementation(async () => { events.push("hide"); });
  vi.mocked(runtimePorts.window.show).mockImplementation(async () => { events.push("show"); });
  const pending = openExternalUrl("https://example.com/");
  expect(events).toEqual(["open"]);
  accept();
  await pending;
  vi.mocked(runtimePorts.openUrl).mockImplementation(async () => {
    events.push("rejected");
    throw new Error("denied");
  });
  await expect(openExternalUrl("https://example.com/", "Google Chrome")).rejects.toThrow("denied");
  expect({ events, calls: vi.mocked(runtimePorts.openUrl).mock.calls }).toEqual({
    events: ["open", "hide", "rejected"],
    calls: [["https://example.com/", "Google Chrome"], ["https://example.com/", "Google Chrome"]],
  });
});
