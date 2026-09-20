import { expect, it, vi } from "vitest";
import { DiagramRenderCache } from "./0_diagramRenderCache";

it("shares concurrent renders, distinguishes source/theme, and retries failures", async () => {
  const cache = new DiagramRenderCache();
  const render = vi.fn().mockResolvedValue("<svg/>");
  const first = cache.render("d2", "a -> b", false, render);
  expect(cache.render("d2", "a -> b", false, render)).toBe(first);
  await first;
  await cache.render("d2", "a -> b", false, render);
  await cache.render("d2", "a -> b", true, render);
  await cache.render("d2", "a -> c", false, render);
  const fail = vi.fn().mockRejectedValueOnce(new Error("compile failed")).mockResolvedValue("<svg/>");
  await expect(cache.render("mermaid", "graph LR", false, fail)).rejects.toThrow("compile failed");
  await cache.render("mermaid", "graph LR", false, fail);
  expect({ renders: render.mock.calls.length, attempts: fail.mock.calls.length, entries: cache.entries.size }).toMatchInlineSnapshot(`
    {
      "attempts": 2,
      "entries": 4,
      "renders": 3,
    }
  `);
});

it("bounds retained output by bytes and evicts the least recently read source", async () => {
  const cache = new DiagramRenderCache(1024, 2);
  const render = vi.fn().mockResolvedValue("svg");
  await cache.render("d2", "a", false, render);
  await cache.render("d2", "b", false, render);
  await cache.render("d2", "a", false, render);
  await cache.render("d2", "c", false, render);
  expect([...cache.entries.keys()]).toEqual(["d2:false:a", "d2:false:c"]);
  await cache.render("d2", "big", false, async () => "x".repeat(1024));
  expect({ entries: cache.entries.size, bytes: cache.bytes }).toEqual({ entries: 0, bytes: 0 });
});
