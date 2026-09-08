import { expect, test } from "@playwright/test";
import { boot, errors, killAllSessions, sessions } from "./0_real";

test.afterAll(killAllSessions);

test("probe heal restored dead tab", async ({ page }) => {
  await boot(page);
  await page.waitForTimeout(2_000);
  console.log("sessions at boot:", sessions(), "errors:", errors.join(" / "));
  await page.keyboard.press("Meta+w");
  await page.waitForTimeout(1_500);
  console.log("hosts after close:", await page.evaluate(() => document.querySelectorAll(".term-host").length));
  await page.keyboard.press("Meta+t");
  await page.waitForTimeout(4_000);
  console.log("sessions after chord:", sessions(), "errors:", errors.join(" / "));
  expect(sessions().length).toBeGreaterThan(0);
});
