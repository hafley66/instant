// Generated rustdoc inside Instant against the real backend. The tier mounts a
// real `cargo doc --no-deps` tree (built by playwright.rustdoc.config.ts under a
// path with a space) at /rustdoc/ and drives the app's own palette command into
// the embedded Chrome. Receipts are the served bytes, the cdp-url event naming
// the tab, and Rustdoc's own search results read back through the copy bridge.
//
// Isolated: private data dir, boop store, tmux dir, no globals, no owner Chrome
// profile (the config precreates <data-dir>/cdp-chrome/Default so cdp.rs never
// clones the real one). No e2e-real/0_real.ts helpers, no stub boop.
import { expect, test, type Page } from "@playwright/test";

const port = Number(process.env.INSTANT_RUSTDOC_PORT ?? 47816);

type EventFrame = { event: string; payload: Record<string, unknown> };

/// Minimal JSON-RPC client over the app's own /ws: subscribe to events and send
/// cdp_send. Node's global WebSocket is enough; no fixture transport.
class Rpc {
  private ws: WebSocket;
  private events: EventFrame[] = [];
  private pending: ((frame: EventFrame) => boolean)[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (message) => {
      const data = typeof message.data === "string" ? message.data : "";
      let frame: { method?: string; params?: { event?: string; payload?: unknown } };
      try {
        frame = JSON.parse(data);
      } catch {
        return;
      }
      if (frame.method !== "events" || !frame.params?.event) return;
      const event: EventFrame = {
        event: frame.params.event,
        payload: (frame.params.payload ?? {}) as Record<string, unknown>,
      };
      this.events.push(event);
      // A probe consumes its frame: the same cdp-copy event must never satisfy a
      // later read (it would answer with the previous page's payload).
      for (let i = 0; i < this.pending.length; i += 1) {
        if (this.pending[i](event)) {
          this.pending.splice(i, 1);
          this.events.splice(this.events.lastIndexOf(event), 1);
          break;
        }
      }
    });
  }

  static async connect(): Promise<Rpc> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("ws failed")));
    });
    const rpc = new Rpc(ws);
    ws.send(JSON.stringify({ jsonrpc: "2.0", method: "events" }));
    return rpc;
  }

  send(frame: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(frame));
  }

  /// Resolve with the next matching event and consume it. Past events count only
  /// once, so a later read cannot be served the previous read's payload.
  wait(match: (frame: EventFrame) => boolean, timeoutMs = 60_000): Promise<EventFrame> {
    const index = this.events.findIndex(match);
    if (index >= 0) return Promise.resolve(this.events.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("event never arrived")), timeoutMs);
      const probe = (frame: EventFrame) => {
        if (!match(frame)) return false;
        clearTimeout(timer);
        resolve(frame);
        return true;
      };
      this.pending.push(probe);
    });
  }

  close(): void {
    this.ws.close();
  }
}

async function boot(page: Page): Promise<void> {
  await page.goto(`/?ws=ws://127.0.0.1:${port}/ws`);
  await expect(page.locator("#sessions-toggle")).toBeVisible({ timeout: 30_000 });
}

/// Run Runtime.evaluate in the doc tab and read the result back through the
/// cdp copy bridge (cdp_send is fire-and-forget; __cdpCopy raises an event).
async function readInTab(rpc: Rpc, id: string, expression: string): Promise<Record<string, unknown>> {
  const next = rpc.wait((frame) => frame.event === "cdp-copy" && frame.payload.id === id);
  rpc.send({
    jsonrpc: "2.0",
    id: 1,
    method: "cdp_send",
    params: {
      id,
      method: "Runtime.evaluate",
      // awaitPromise so an async expression resolves before the copy bridge runs.
      params: {
        expression: `(async () => { __cdpCopy(JSON.stringify(await (${expression}))); })()`,
        awaitPromise: true,
      },
    },
  });
  const frame = await next;
  return JSON.parse(String(frame.payload.text)) as Record<string, unknown>;
}

test.afterEach(async ({ page }) => {
  await page.keyboard.press("Escape").catch(() => {});
});

test("serves a generated cargo doc tree read-only within the doc root", async ({ request }) => {
  const listing = await request.get("/rustdoc/");
  expect(listing.status()).toBe(200);
  const listingText = await listing.text();
  expect(listingText).toContain("docprobe/index.html");

  const index = await request.get("/rustdoc/docprobe/index.html");
  expect(index.status()).toBe(200);
  expect(index.headers()["content-type"]).toContain("text/html");
  const indexText = await index.text();
  expect(indexText).toContain("docprobe");
  expect(indexText).toContain("rustdoc");

  const item = await request.get("/rustdoc/docprobe/struct.Pair.html");
  expect(item.status()).toBe(200);
  expect(await item.text()).toContain("Pair");

  const crates = await request.get("/rustdoc/crates.js");
  expect(crates.status()).toBe(200);
  expect(crates.headers()["content-type"]).toContain("javascript");
  expect(await crates.text()).toContain("docprobe");

  // A static asset named by the page itself, so this does not hardcode a hash.
  const assetPath = indexText.match(/static\.files\/[A-Za-z0-9._-]+\.(?:js|css|woff2)/)?.[0];
  expect(assetPath).toBeTruthy();
  const asset = await request.get(`/rustdoc/${assetPath}`);
  expect(asset.status()).toBe(200);

  expect((await request.get("/rustdoc/does-not-exist.html")).status()).toBe(404);
  expect((await request.get("/rustdoc/..%2f..%2fCargo.toml")).status()).toBe(404);
  expect((await request.get("/rustdoc/%2e%2e%2fCargo.toml")).status()).toBe(404);
});

test("opens generated docs in the embedded browser and runs Rustdoc search", async ({ page }) => {
  await boot(page);
  const rpc = await Rpc.connect();
  try {
    // The palette is the app's own entry point; run the command by name.
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "P", code: "KeyP", metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    });
    await page.locator(".cmdp-input").fill("Rustdoc");
    await page.locator(".cmdp-input").press("Enter");

    // The tab is a dock browser panel backed by the shared Chrome engine.
    await expect(page.locator(".term-host").last()).toBeVisible({ timeout: 60_000 });

    // The initial load is started from the CDP target URL before the ws attaches,
    // so there is no frameNavigated event for it; the screencast id names the tab.
    const opened = await rpc.wait((frame) => frame.event === "cdp-frame" && String(frame.payload.id).includes("/rustdoc/"));
    const id = String(opened.payload.id);
    expect(id).toContain("/rustdoc/");

    const loaded = await readInTab(rpc, id, `({
      title: document.title,
      protocol: location.protocol,
      crates: [...document.querySelectorAll("a")].map((a) => a.getAttribute("href")),
    })`);
    expect(loaded.protocol).toBe("http:");
    expect(String(loaded.title)).toBe("Generated documentation");
    expect(loaded.crates as string[]).toContain("docprobe/index.html");

    // Follow the crate link the listing rendered. The ws is attached now, so the
    // navigation raises cdp-url where the initial target load did not.
    rpc.send({
      jsonrpc: "2.0",
      id: 2,
      method: "cdp_send",
      params: { id, method: "Runtime.evaluate", params: { expression: `document.querySelector('a[href="docprobe/index.html"]').click()` } },
    });
    await rpc.wait((frame) => frame.event === "cdp-url" && String(frame.payload.url).includes("docprobe/index.html"));
    const crate = await readInTab(rpc, id, `(async () => {
      await new Promise((r) => setTimeout(r, 500));
      return { title: document.title, topbar: !!customElements.get("rustdoc-topbar") };
    })()`);
    expect(String(crate.title)).toContain("docprobe");
    expect(crate.topbar).toBe(true);

    // Search is the feature file:// blocks. Drive the box, then read results.
    const searched = await readInTab(rpc, id, `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      // 'S' (or '/') is Rustdoc's own shortcut to reveal and focus the search box;
      // the input exists but is hidden before it.
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true }));
      await sleep(500);
      const box = document.querySelector("input.search-input");
      box.focus();
      for (const ch of "add") {
        box.value += ch;
        box.dispatchEvent(new Event("input", { bubbles: true }));
        box.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
      }
      await sleep(2500);
      return {
        value: box.value,
        focused: document.activeElement === box,
        names: [...document.querySelectorAll(".result-name")].map((a) => a.textContent.trim()).slice(0, 6),
      };
    })()`);
    expect(searched.value).toBe("add");
    expect((searched.names as string[]).join(" ")).toContain("docprobe::add");
    await page.waitForTimeout(500);
    await page.screenshot({ path: "docs/screenshots/06-rustdoc-browser.png" });

    // Intra-doc navigation: click the struct link, then read the new title.
    rpc.send({
      jsonrpc: "2.0",
      id: 2,
      method: "cdp_send",
      params: { id, method: "Runtime.evaluate", params: { expression: `document.querySelector('a.struct[href="struct.Pair.html"]').click()` } },
    });
    await rpc.wait((frame) => frame.event === "cdp-url" && String(frame.payload.url).includes("struct.Pair.html"));
    const item = await readInTab(rpc, id, `({ title: document.title, path: location.pathname })`);
    expect(String(item.title)).toContain("Pair");
    expect(String(item.path)).toContain("struct.Pair.html");
  } finally {
    rpc.close();
  }
});
