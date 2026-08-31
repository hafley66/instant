import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { $, browser } from "@wdio/globals";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const screenshot = path.join(root, "artifacts", "native-e2e", "instant-native-smoke.png");

type WindowReceipt = {
  handle: string;
  href: string;
  title: string;
  mainMarker: boolean;
};

async function switchToMainWindow(): Promise<WindowReceipt[]> {
  const receipts: WindowReceipt[] = [];
  let mainHandle: string | undefined;
  for (const handle of await browser.getWindowHandles()) {
    await browser.switchToWindow(handle);
    receipts.push(await browser.execute((windowHandle) => ({
      handle: windowHandle,
      href: window.location.href,
      title: document.title,
      mainMarker: document.querySelector(".title-bar-text")?.textContent === "instant — summon",
    }), handle));
    if (receipts.at(-1)?.mainMarker) mainHandle = handle;
  }
  if (!mainHandle) throw new Error(`main WebView was absent: ${JSON.stringify(receipts)}`);
  await browser.switchToWindow(mainHandle);
  return receipts;
}

describe("compiled Instant native WebView", () => {
  it("boots the bundled UI in WKWebView and captures the native renderer", async () => {
    const windows = await switchToMainWindow();
    const devicePixelRatio = await browser.execute(() => window.devicePixelRatio);
    await browser.setWindowSize(820 * devicePixelRatio, 540 * devicePixelRatio);
    const title = await browser.getTitle();
    const titleBar = await $(".title-bar-text");
    await titleBar.waitForDisplayed();
    try {
      await $("#sessions-toggle").waitForDisplayed();
    } catch (error) {
      const boot = await browser.execute(() => ({
        readyState: document.readyState,
        bodyText: document.body.innerText,
        scripts: [...document.scripts].map(({ src, type }) => ({ src, type })),
        earlyDiagnostics: window.__instantEarlyDiagnostics ?? [],
      }));
      throw new Error(`Instant boot marker failed: ${JSON.stringify(boot)}`, { cause: error });
    }
    await browser.waitUntil(() => browser.execute(() =>
      document.fonts.status === "loaded"
      && document.querySelectorAll("#actbar .actbar-item[data-panel]").length >= 8,
    ));

    const provenance = await browser.execute(() => ({
      href: window.location.href,
      origin: window.location.origin,
      tauriInternals: typeof window.__TAURI_INTERNALS__ === "object",
      userAgent: navigator.userAgent,
      chromiumMarker: "chrome" in window,
      devicePixelRatio: window.devicePixelRatio,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    }));

    assert.deepEqual(
      {
        title,
        titleBar: await titleBar.getText(),
        windowHandles: windows.map(({ handle }) => handle).sort(),
        origin: provenance.origin,
        tauriInternals: provenance.tauriInternals,
        chromiumMarker: provenance.chromiumMarker,
      },
      {
        title: "instant",
        titleBar: "instant — summon",
        windowHandles: ["dropcatcher", "main"],
        origin: "tauri://localhost",
        tauriInternals: true,
        chromiumMarker: false,
      },
    );
    assert.match(provenance.href, /^tauri:\/\/localhost\/?$/);
    assert.match(provenance.userAgent, /AppleWebKit/);
    assert.ok(provenance.devicePixelRatio >= 1);
    assert.ok(provenance.viewport.width >= 780, JSON.stringify(provenance.viewport));
    assert.ok(provenance.viewport.height >= 480, JSON.stringify(provenance.viewport));

    mkdirSync(path.dirname(screenshot), { recursive: true });
    await browser.saveScreenshot(screenshot);
    const png = readFileSync(screenshot);
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok(png.byteLength > 1_000, `native screenshot was only ${png.byteLength} bytes`);
  });
});
