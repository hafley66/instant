// The Paint rail panel over the real backend: a PNG on disk opened through the
// panel's own path box, layers counted from miniPaint's own layer list in the
// DOM, and the save written by the backend's `save_meme`. The rail cases drive
// the Rules button and the rail's visibility menu.
import { expect, test, type Frame, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot, closeTabs, killAllSessions, shot, toast } from "./0_real";

// A 64x64 solid PNG. miniPaint sizes the canvas from the opened image, so the
// caption boxes (5% of the width) land on a real canvas instead of one pixel.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAATklEQVR42u3PQQkAAAgEsAt2/TGWEXwLgxVYpn0tAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKXBTfrAS0KlmeBAAAAAElFTkSuQmCC";

const dirs: string[] = [];

function paintFiles(): { first: string; second: string } {
  const dir = mkdtempSync(join(tmpdir(), "real-paint-"));
  dirs.push(dir);
  const first = join(dir, "paint-first.png");
  const second = join(dir, "paint-second.png");
  writeFileSync(first, Buffer.from(PNG_B64, "base64"));
  writeFileSync(second, Buffer.from(PNG_B64, "base64"));
  return { first, second };
}

/// The miniPaint document inside the newest Paint panel. The vendored editor is
/// same-origin, so its own markup is the receipt.
async function paintFrame(page: Page): Promise<Frame> {
  await expect
    .poll(() => page.frames().filter((frame) => frame.url().includes("/vendor/miniPaint/")).length, {
      timeout: 30_000,
      message: "the paint panel never loaded miniPaint",
    })
    .toBeGreaterThan(0);
  return page.frames().filter((frame) => frame.url().includes("/vendor/miniPaint/")).at(-1)!;
}

/// One row per layer in miniPaint's Layers block, the list a user reads.
const layerRows = (frame: Frame): Locator => frame.locator("#layers .item");

/// Type a path into the panel's path box and press its open button, the way a
/// user opens a painting.
async function openPainting(page: Page, path: string): Promise<void> {
  const box = page.locator(".paint-path");
  await box.fill(path);
  await page.getByRole("button", { name: "open", exact: true }).click();
  await expect.poll(() => box.inputValue(), { timeout: 20_000 }).toBe(path);
}

/// A keyboard chord on the window. Paint puts focus inside the miniPaint
/// iframe, and a key pressed there never reaches the app's window listener, so
/// the chord is dispatched on the window tinykeys is bound to.
async function chord(page: Page, key: string, code: string, shift = false): Promise<void> {
  await page.evaluate(([k, c, s]) => {
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: k as string,
      code: c as string,
      metaKey: true,
      shiftKey: s as boolean,
      bubbles: true,
      cancelable: true,
    }));
  }, [key, code, shift] as [string, string, boolean]);
}

test.afterEach(async ({ page }) => {
  await closeTabs(page);
});

test.afterAll(() => {
  killAllSessions();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("Paint layers revive after save, Cmd+W, and Cmd+Shift+T", async ({ page }) => {
  const { first, second } = paintFiles();
  await boot(page);
  await page.locator("#paint-toggle").click();
  const frame = await paintFrame(page);
  // The second painting is opened first so the recent list holds it; the panel
  // then works on the first one.
  await openPainting(page, second);
  await openPainting(page, first);
  await expect(layerRows(frame)).toHaveCount(1);

  const insertLayer = frame.locator("#insert_layer");
  await insertLayer.click();
  await insertLayer.click();
  await expect(layerRows(frame)).toHaveCount(3);

  // The save receipt is the file itself: it is removed first, and the backend's
  // `save_meme` puts it back.
  rmSync(first);
  await page.getByRole("button", { name: "save", exact: true }).click();
  await expect.poll(() => toast(page), { timeout: 20_000 }).toContain("saved");
  await expect.poll(() => existsSync(first), { timeout: 20_000 }).toBe(true);

  await chord(page, "w", "KeyW");
  await expect(page.locator(".paint-root")).toHaveCount(0);

  await chord(page, "T", "KeyT", true);
  await expect(page.locator(".paint-root")).toHaveCount(1);
  const revived = await paintFrame(page);
  await expect(layerRows(revived)).toHaveCount(3);

  // One edit on the revived document, then a recent painting picked from the
  // panel's dropdown. The unsaved-changes confirm is dismissed, so the edit is
  // dropped and the recent file loads as its single layer.
  await revived.locator("#insert_layer").click();
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.locator("select.paint-recent").selectOption(second);
  await expect(layerRows(revived)).toHaveCount(1);
  await shot(page, "paint-panel-01-revived");
});

test("Paint caption panel creates top and bottom meme text layers", async ({ page }) => {
  const { first } = paintFiles();
  await boot(page);
  await page.locator("#paint-toggle").click();
  const frame = await paintFrame(page);
  await openPainting(page, first);
  await expect(layerRows(frame)).toHaveCount(1);

  const panel = page.getByTestId("meme-captions");
  await expect(panel).toBeVisible();
  await panel.getByLabel("top text").fill("TOP TEXT");
  await panel.getByLabel("bottom text").fill("BOTTOM TEXT");
  await panel.getByLabel("top font size").fill("72");
  await panel.getByLabel("top fill color").fill("#ff0000");
  await panel.getByRole("button", { name: "top bold" }).click();

  // miniPaint names each caption layer, so the layer list is the visible
  // receipt that both captions became layers.
  await expect(frame.locator("#layers .layer_name", { hasText: "Meme top caption" })).toHaveCount(1);
  await expect(frame.locator("#layers .layer_name", { hasText: "Meme bottom caption" })).toHaveCount(1);
  // The text and its style live in the layer data miniPaint renders from; the
  // editor's own `Layers` API is what the panel writes through.
  await expect
    .poll(() => frame.evaluate(() => {
      const layers = (window as Window & { Layers?: { get_layers?: () => Array<{ name: string; data?: Array<Array<{ text: string; meta: Record<string, unknown> }>> }> } }).Layers;
      return (layers?.get_layers?.() ?? []).map((layer) => [layer.name, layer.data?.[0]?.[0]?.text, layer.data?.[0]?.[0]?.meta]);
    }), { timeout: 20_000 })
    .toContainEqual(["Meme top caption", "TOP TEXT", expect.objectContaining({ size: 72, fill_color: "#ff0000", bold: true })]);
  await expect
    .poll(() => frame.evaluate(() => {
      const layers = (window as Window & { Layers?: { get_layers?: () => Array<{ name: string; data?: Array<Array<{ text: string }>> }> } }).Layers;
      return (layers?.get_layers?.() ?? []).map((layer) => [layer.name, layer.data?.[0]?.[0]?.text]);
    }), { timeout: 20_000 })
    .toContainEqual(["Meme bottom caption", "BOTTOM TEXT"]);
  await shot(page, "paint-panel-02-captions");
});

test("Rules opens with Metrics as secondary navigation", async ({ page }) => {
  await boot(page);
  const rulesButton = page.locator("#rules-toggle");
  await expect(rulesButton).toBeVisible();

  await rulesButton.click();
  await expect(page.locator(".rules-panel")).toBeVisible();

  await expect(rulesButton.locator(".actbar-exp")).toHaveCount(1);
  await rulesButton.locator(".actbar-exp").click();
  await expect(page.locator("#rules-metrics-child")).toBeVisible();
  await expect(page.locator("#rules-table")).toBeVisible();
  await shot(page, "paint-panel-03-rules-metrics");
});

test("rail context menu hides and restores navigation items", async ({ page }) => {
  await boot(page);
  const rulesButton = page.locator("#rules-toggle");
  await rulesButton.click({ button: "right" });

  const hideRules = page.locator(".ctx-item", { hasText: "✓ Rules" });
  await expect(hideRules).toBeVisible();
  await hideRules.click();
  await expect(rulesButton).toHaveCount(0);

  await page.locator("#sessions-toggle").dispatchEvent("contextmenu", {
    bubbles: true,
    button: 2,
    clientX: 16,
    clientY: 16,
  });
  const restoreRules = page.locator(".ctx-item", { hasText: "Rules" });
  await expect(restoreRules).toBeVisible();
  await restoreRules.click();
  await expect(page.locator("#rules-toggle")).toBeVisible();
  await shot(page, "paint-panel-04-rail-menu");
});
