import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bus,
  dropMailDir,
  hasSession,
  killProofSessions,
  killSession,
  makeMailDir,
  proofId,
  SOCKET,
  wireRealNative,
} from "./0_live";

// Layer B of the live suite: the real strip components over the real socket
// and mail dir; only the IPC transport is the exposed binding (0_live).
test.afterEach(() => killProofSessions());

const MOD = process.platform === "darwin" ? "Meta" : "Control";

// The strip auto-appears only with rows; summoning first gives the empty
// shell (and its refresh button) before the first dispatch exists.
async function summonStrip(page: import("@playwright/test").Page): Promise<void> {
  await expect(page.getByTestId("term-stub")).toBeVisible();
  await page.keyboard.press(`${MOD}+Shift+Period`);
  await expect(page.getByTestId("in-tab-strip")).toBeVisible();
}

function dispatchLane(lane: string, mailDir: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "proof-cwd-"));
  bus(
    ["dispatch", "--to", lane, "--cwd", cwd, "--cmd", "sleep 300", "--harness", "shell", "--socket", SOCKET, "--resolve-wait", "0"],
    mailDir,
  );
  return cwd;
}

test("a dispatched lane rows the strip; its death leaves the going-on bar with zero clicks", async ({ page }) => {
  const mailDir = makeMailDir();
  const lane = proofId("row");
  try {
    await wireRealNative(page, mailDir);
    await page.goto("/e2e-dock-strip-in-tab.html?e2e=1");
    await summonStrip(page);

    dispatchLane(lane, mailDir);
    expect(hasSession(lane)).toBe(true);

    // The mail fs-watch is claimFsWatch-disabled on e2e pages, so the arrival
    // leg is one refresh; every transition after it is the poll's, zero clicks.
    await page.getByRole("button", { name: "refresh" }).click();
    const laneRow = page.locator("tr").filter({ hasText: lane });
    await expect(laneRow).toBeVisible();
    await expect(laneRow).toContainText("live");

    killSession(lane);
    await expect(laneRow).toHaveCount(0, { timeout: 12_000 });
  } finally {
    dropMailDir(mailDir);
  }
});

test("the row X kills the real tmux session", async ({ page }) => {
  const mailDir = makeMailDir();
  const lane = proofId("x");
  try {
    await wireRealNative(page, mailDir);
    await page.goto("/e2e-dock-strip-in-tab.html?e2e=1");
    await summonStrip(page);

    dispatchLane(lane, mailDir);
    await page.getByRole("button", { name: "refresh" }).click();
    await expect(page.locator("tr").filter({ hasText: lane })).toBeVisible();

    await page.getByTestId(`strip-kill-${lane}`).click();
    await expect.poll(() => hasSession(lane), { timeout: 10_000 }).toBe(false);
    await expect(page.locator("tr").filter({ hasText: lane })).toHaveCount(0, { timeout: 12_000 });
  } finally {
    dropMailDir(mailDir);
  }
});

test("a done lane renders as history and its double-click never mints a session", async ({ page }) => {
  const mailDir = makeMailDir();
  const lane = proofId("dead");
  try {
    dispatchLane(lane, mailDir);
    killSession(lane);
    expect(hasSession(lane)).toBe(false);

    await wireRealNative(page, mailDir);
    await page.goto("/e2e-dock-strip.html?e2e=1");
    await page.locator('#actbar [data-panel="dock-strip"]').click();

    const laneRow = page.locator("tr").filter({ hasText: lane });
    await expect(laneRow).toBeVisible();
    await expect(laneRow).toContainText("done");

    await laneRow.locator(".s-name").dblclick();
    const opened = await page.evaluate(
      () => (window as Window & { __dockStripOpened?: string }).__dockStripOpened ?? null,
    );
    expect(opened).toBe(null);
    expect(hasSession(lane)).toBe(false);
  } finally {
    dropMailDir(mailDir);
  }
});

test("history waterfall bars real lanes and the brush narrows them away", async ({ page }) => {
  const mailDir = makeMailDir();
  const laneA = proofId("wfa");
  const laneB = proofId("wfb");
  try {
    await wireRealNative(page, mailDir);
    await page.goto("/e2e-dock-strip-in-tab.html?e2e=1");
    await summonStrip(page);

    dispatchLane(laneA, mailDir);
    dispatchLane(laneB, mailDir);
    await page.getByRole("button", { name: "refresh" }).click();
    await expect(page.locator("tr").filter({ hasText: laneA })).toBeVisible();

    await page.getByText("Show active").click();
    const waterfall = page.getByTestId("waterfall");
    await expect(waterfall).toBeVisible();
    await expect(page.getByTestId("waterfall-count")).toHaveText("2 sessions");
    await expect(page.locator(".waterfall-bar")).toHaveCount(2);

    // Registry-only lanes have no store ts (spans anchor at the clock), so
    // narrowing-drops-sessions stays waterfall.spec.ts's; here the gesture runs.
    const sel = page.locator(".waterfall-overview .selection");
    await expect(sel).toBeVisible();
    const selBox = await sel.boundingBox();
    const y0 = selBox!.y + selBox!.height / 2;
    await page.mouse.move(selBox!.x + selBox!.width - 2, y0);
    await page.mouse.down();
    await page.mouse.move(selBox!.x + selBox!.width * 0.1, y0, { steps: 10 });
    await page.mouse.up();

    await expect
      .poll(async () => Number(await sel.getAttribute("width")))
      .toBeLessThan(selBox!.width * 0.5);
    await expect(page.getByTestId("waterfall-count")).toHaveText("2 sessions");
    await expect(page.locator(".waterfall-bar")).toHaveCount(2);
  } finally {
    dropMailDir(mailDir);
  }
});
