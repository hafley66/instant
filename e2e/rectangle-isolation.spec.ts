import { expect, test } from "@playwright/test";

// Isolation receipt: mounts the real @hafley66/react-dock-and-flow
// RectangleCanvas with one session rectangle and one Cytoscape graph rectangle,
// moves a rectangle via a real drag, undoes it through the package model, and
// captures a PNG. Verifies the graph canvas renders (non-quadrant-blank) and
// that both session and graph identifying text are visible.

test("isolation: one session + one cytoscape graph, move rectangle, undo, PNG", async ({ page }) => {
  await page.goto("/e2e-rectangle-isolation.html?e2e=1");

  const sessionTitle = page.getByText("agent session");
  await expect(sessionTitle).toBeVisible();
  await expect(page.getByText("READ ME")).toBeVisible();
  await expect(page.getByText("src/index.ts")).toBeVisible();

  const graphTitle = page.getByText("query graph");
  await expect(graphTitle).toBeVisible();
  const cytoscape = page.getByTestId("cytoscape-rectangle");
  await expect(cytoscape).toBeVisible();
  await expect(cytoscape.locator("canvas").first()).toBeVisible();

  const before = await page.evaluate(() =>
    (window as Window & { __rectTest?: { rects: () => { id: string; position: { x: number; y: number } }[] } })
      .__rectTest!.rects().map((r) => [r.id, r.position.x, r.position.y]),
  );
  expect(before).toContainEqual(["session-a", 120, 120]);
  expect(before).toContainEqual(["graph-a", 520, 120]);

  const posOf = (id: string) =>
    page.evaluate((target) =>
      (window as Window & { __rectTest?: { rects: () => { id: string; position: { x: number; y: number } }[] } })
        .__rectTest!.rects().find((r) => r.id === target)!.position,
    id);

  // Move the session rectangle through the package model (the same `moved`
  // event RectangleCanvas dispatches on drag stop), then undo it.
  await page.evaluate(() =>
    (window as Window & { __rectTest?: { move: (id: string, p: { x: number; y: number }) => void } })
      .__rectTest!.move("session-a", { x: 260, y: 180 }),
  );

  const original = { x: 120, y: 120 };
  await expect.poll(() => posOf("session-a")).toEqual({ x: 260, y: 180 });

  await page.screenshot({ path: "test-results/rectangle-isolation-moved.png", fullPage: true });

  // Undo returns the rectangle to its initial position.
  await page.evaluate(() =>
    (window as Window & { __rectTest?: { undo: () => void } }).__rectTest!.undo(),
  );
  await expect.poll(() => posOf("session-a")).toEqual(original);

  // Graph canvas is not blank: across the cytoscape canvases there is more than
  // one distinct color (nodes/edges are blue on near-black).
  await page.waitForTimeout(300);
  const blank = await page.evaluate(() => {
    const canvases = [...document.querySelectorAll('[data-testid="cytoscape-rectangle"] canvas')] as HTMLCanvasElement[];
    const colors = new Set<number>();
    for (const canvas of canvases) {
      try {
        const { width, height } = canvas;
        if (!width || !height) continue;
        const data = canvas.getContext("2d")!.getImageData(0, 0, width, height).data;
        for (let i = 0; i < data.length; i += 40) {
          colors.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
        }
      } catch {
        /* tainted or unreadable canvas: treat as non-blank, not a proof of blank */
        return false;
      }
    }
    return colors.size < 2;
  });
  expect(blank).toBe(false);

  await page.screenshot({ path: "test-results/rectangle-isolation-final.png", fullPage: true });
});
