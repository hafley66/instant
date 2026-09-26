/** @vitest-environment jsdom */
import { beforeEach, expect, it, vi } from "vitest";
const ports = vi.hoisted(() => ({ invoke: vi.fn(), render: vi.fn(), unmount: vi.fn(), create: vi.fn(), mode: "dark" }));
vi.mock("./generated/native", () => ({ invoke: ports.invoke }));
vi.mock("react-dom/client", () => ({ createRoot: ports.create }));
vi.mock("./1_FileImageViewer", () => ({ FileImageViewer: () => null }));
vi.mock("./0_MonacoCodeViewer", () => ({ MonacoCodeViewer: () => null }));
vi.mock("@hafley66/md", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hafley66/md")>()),
  renderD2: vi.fn(),
  renderMermaidSvg: vi.fn(),
}));
vi.mock("./core", () => ({ IMAGE_EXTS: new Set(["svg", "png"]), escapeHtml: (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\"/g, "&quot;") }));
vi.mock("./0_settings", () => ({ settings: { mode: { $: () => ports.mode } } }));
import { disposePreview, renderPathInto, previewTextByNode } from "./2_previewRenderer";

beforeEach(() => {
  vi.clearAllMocks();
  ports.create.mockReturnValue({ render: ports.render, unmount: ports.unmount });
  ports.mode = "dark";
});

it("preserves a loaded SVG across duplicate reads and theme changes, replacing it only when source changes", async () => {
  const node = document.createElement("div");
  ports.invoke.mockResolvedValue('<svg viewBox="0 0 800 600"/>');
  await renderPathInto(node, "/diagram.svg");
  await renderPathInto(node, "/diagram.svg");
  ports.mode = "light";
  await renderPathInto(node, "/diagram.svg");
  expect([ports.create.mock.calls.length, ports.unmount.mock.calls.length]).toEqual([1, 0]);
  ports.invoke.mockResolvedValue('<svg viewBox="0 0 900 600"/>');
  await renderPathInto(node, "/diagram.svg");
  disposePreview(node);
  expect([ports.create.mock.calls.length, ports.unmount.mock.calls.length]).toEqual([2, 2]);
});

it("preserves an editor's Copy text across an unchanged disk read", async () => {
  const node = document.createElement("div");
  ports.invoke.mockResolvedValue("disk text");
  await renderPathInto(node, "/source.ts");
  ports.render.mock.calls[0][0].props.onText("unsaved editor text");
  await renderPathInto(node, "/source.ts");
  expect(previewTextByNode.get(node)).toBe("unsaved editor text");
});

it("discards a pending read after disposal and keeps the latest overlapping request", async () => {
  const node = document.createElement("div");
  let resolve!: (text: string) => void;
  ports.invoke.mockReturnValueOnce(new Promise<string>((done) => { resolve = done; }));
  const old = renderPathInto(node, "/source.ts");
  ports.invoke.mockResolvedValue("latest");
  await renderPathInto(node, "/source.ts", 12);
  resolve("obsolete");
  await old;
  expect(previewTextByNode.get(node)).toBe("latest");
  ports.invoke.mockReturnValueOnce(new Promise<string>((done) => { resolve = done; }));
  const closing = renderPathInto(node, "/source.ts");
  disposePreview(node);
  resolve("closed");
  await closing;
  expect({ mounts: ports.create.mock.calls.length, unmounts: ports.unmount.mock.calls.length,
    retainedText: previewTextByNode.has(node) }).toEqual({ mounts: 1, unmounts: 1, retainedText: false });
});

it("renders errors as text and disposes an existing viewer", async () => {
  const node = document.createElement("div");
  ports.invoke.mockResolvedValue("code");
  await renderPathInto(node, "/source.ts");
  ports.invoke.mockRejectedValue(new Error('<img src=x onerror="bad()">'));
  await renderPathInto(node, "/source.ts");
  expect({ images: node.querySelectorAll("img").length, unmounts: ports.unmount.mock.calls.length,
    error: node.querySelector(".fs-preview-empty")?.textContent }).toEqual({ images: 0, unmounts: 1,
    error: 'Error: <img src=x onerror="bad()">' });
});

it("does not read a D2 PNG fallback after its source render is superseded", async () => {
  const node = document.createElement("div");
  let resolveSource!: (text: string) => void;
  ports.invoke
    .mockRejectedValueOnce(new Error("no SVG sibling"))
    .mockReturnValueOnce(new Promise<string>((done) => { resolveSource = done; }));
  const stale = renderPathInto(node, "/large.d2");
  await vi.waitFor(() => expect(ports.invoke).toHaveBeenCalledTimes(2));
  ports.invoke.mockResolvedValueOnce("latest");
  await renderPathInto(node, "/source.ts");
  resolveSource("a -> b");
  await stale;
  expect(ports.invoke.mock.calls.map(([command, args]) => [command, args.path])).toEqual([
    ["read_text", "/large.svg"],
    ["read_text", "/large.d2"],
    ["read_text", "/source.ts"],
  ]);
});
