// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DiagramLightbox } from "@hafley66/md";

it("retains pan and zoom across parent renders and replacement SVGs until Fit", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500);
  const frame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const source = (revision: number) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 500"><text>${revision}</text></svg>`;
  const render = async (svg: string) => act(() => root.render(
    <DiagramLightbox svg={svg} label="refresh regression" language="d2" dark onClose={() => {}} />,
  ));
  const stage = () => document.querySelector<HTMLDivElement>(".diagram-vector-stage")!;
  const viewport = () => stage().querySelector("svg")!;
  const box = () => {
    const svg = viewport();
    const [x, y, width, height] = svg.getAttribute("viewBox")!.split(" ").map(Number);
    const [scale, , , , tx, ty] = svg.style.transform.slice(7, -1).split(",").map(Number);
    const w = width / (3 * scale), h = height / (3 * scale);
    return [x - tx * w / 1000, y - ty * h / 500, w, h].map(Math.round).join(" ");
  };
  const captured: Record<string, string | null> = {};
  try {
    await render(source(1));
    await frame();
    await act(() => stage().dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY: -Math.log(2) / 0.002, cancelable: true })));
    await act(() => stage().dispatchEvent(new WheelEvent("wheel", { deltaX: 80, deltaY: 40, cancelable: true })));
    await frame();
    captured.reading = box();
    const held = viewport();
    await render(source(1));
    captured.parentRender = box();
    expect(viewport()).toBe(held);
    await render(source(2));
    captured.newSvg = box();
    expect(viewport().textContent).toBe("2");
    await act(() => document.querySelector<HTMLButtonElement>('button[title="fit the complete SVG"]')!.click());
    await frame();
    captured.fit = box();
    expect(captured).toMatchInlineSnapshot(`
      {
        "fit": "0 0 1000 500",
        "newSvg": "290 145 500 250",
        "parentRender": "290 145 500 250",
        "reading": "290 145 500 250",
      }
    `);
  } finally {
    await act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
