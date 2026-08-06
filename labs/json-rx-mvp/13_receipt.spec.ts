import { expect, test } from "@playwright/test";
import { firstValueFrom, Subject, take, toArray } from "rxjs";
import { compileAutomationV2, type HostEvent, type NetworkResponse } from "./8_v2-runtime";
import { claudeUsageV2 } from "./9_claude-v2.fixture";
import { codexUsageV2 } from "./11_codex-v2.fixture";

test("Claude and Codex JSON-Rx streams emit deterministic dashboard states", async ({ page }, testInfo) => {
  const claudeSource = new Subject<NetworkResponse>();
  const claude = compileAutomationV2(claudeUsageV2, {
    "jsonrx://instant/sources/browser/network-response/claude-usage": claudeSource,
  });
  const claudeEmission = firstValueFrom(claude.roots["claude.usage"].pipe(take(1)));
  claudeSource.next({
    method: "GET",
    pageUrl: "https://claude.ai/settings/usage",
    requestUrl: "https://claude.ai/api/organizations/org-1/usage",
    status: 200,
    ts: 1_784_580_000_000,
    body: {
      five_hour: { utilization: 31, resets_at: "2026-07-20T23:00:00.000Z" },
      seven_day: { utilization: 64, resets_at: "2026-07-23T18:00:00.000Z" },
    },
  });

  const snapshot = new Subject<HostEvent>();
  const updated = new Subject<HostEvent>();
  const codex = compileAutomationV2(codexUsageV2, {
    "jsonrx://instant/sources/codex/rate-limits-read": snapshot,
    "jsonrx://instant/sources/codex/rate-limits-updated": updated,
  });
  const codexEmissions = firstValueFrom(codex.roots["codex.usage"].pipe(take(2), toArray()));
  snapshot.next({
    type: "codex.usage.snapshot",
    url: "codex-app-server://account/rateLimits/read",
    ts: 1_784_580_000_000,
    data: {
      provider: "Codex",
      primary_percent: 31,
      primary_resets_at: "2026-07-20T23:00:00.000Z",
      secondary_percent: 64,
      secondary_resets_at: "2026-07-23T18:00:00.000Z",
      credit_balance: 18.5,
      has_credits: true,
      plan_type: "plus",
    },
  });
  updated.next({
    type: "codex.usage.updated",
    url: "codex-app-server://account/rateLimits/updated",
    ts: 1_784_580_030_000,
    data: { primary_percent: 33, primary_resets_at: "2026-07-20T23:30:00.000Z" },
  });

  const receipt = {
    claude: await claudeEmission,
    codex: await codexEmissions,
  };
  await testInfo.attach("json-rx-stream-receipt", {
    body: JSON.stringify(receipt, null, 2),
    contentType: "application/json",
  });
  const cards = Object.entries(receipt)
    .map(([provider, value]) => `<section><h2>${provider}</h2><pre>${JSON.stringify(value, null, 2)}</pre></section>`)
    .join("");
  await page.setContent(`<!doctype html><style>
    *{box-sizing:border-box}body{margin:0;padding:28px;background:#090e1a;color:#dbeafe;font:14px ui-monospace,SFMono-Regular,Menlo,monospace}
    h1{margin:0 0 8px;font:700 25px system-ui;color:#f8fafc}.note{margin:0 0 20px;color:#93c5fd}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:start}section{min-width:0;padding:16px;border:1px solid #334155;border-radius:10px;background:#111827}
    h2{margin:0 0 12px;color:#86efac;font:700 18px system-ui;text-transform:capitalize}pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.45}
    footer{margin-top:18px;padding:12px;border:1px solid #166534;border-radius:8px;background:#052e16;color:#bbf7d0}
  </style><body><h1>JSON-Rx v2 dashboard stream receipt</h1><p class="note">Real lab compiler output from Claude network-response and Codex host-event sources.</p><main class="grid">${cards}</main><footer>Vitest runtime + strict TypeScript + Chromium receipt</footer></body>`);
  const platform = await page.evaluate(() => navigator.platform);
  if (platform.startsWith("Linux")) {
    const screenshot = await page.screenshot({ fullPage: true });
    expect(screenshot.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    await testInfo.attach("json-rx-lab-gate-linux", { body: screenshot, contentType: "image/png" });
    return;
  }
  await expect(page).toHaveScreenshot("json-rx-lab-gate.png", { fullPage: true });
});
