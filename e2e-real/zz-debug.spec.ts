import { test, type Page } from "@playwright/test";
import { boot, openTab, sessions } from "./0_real";

async function diag(page: Page) {
  return page.evaluate(() => ({
    tabs: [...document.querySelectorAll(".dv-default-tab")].map((t) => t.textContent),
    hosts: document.querySelectorAll(".term-host").length,
    bootError: document.getElementById("boot-error")?.textContent ?? "",
    toast: document.querySelector(".app-toast.on")?.textContent ?? "",
    flash: document.querySelector(".status-flash")?.textContent ?? "",
  }));
}

test("debug rapid boots with diagnostics", async ({ browser }) => {
  for (let i = 0; i < 6; i++) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await boot(page);
    try {
      const s = await openTab(page);
      console.log(`boot ${i} ok`, s, sessions().join(","));
    } catch {
      console.log(`boot ${i} FAIL`, JSON.stringify(await diag(page)), sessions().join(","));
    }
    await ctx.close();
  }
});
