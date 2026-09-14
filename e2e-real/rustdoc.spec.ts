// Generated rustdoc inside Instant against the real backend. The tier mounts a
// real `cargo doc --no-deps` tree (built by playwright.rustdoc.config.ts under a
// path with a space), keeps the serve route's direct HTTP checks, and drives the
// product entry points (the palette and the normal file-open flow) into the
// embedded Chrome over the backend's loopback doc service. Receipts are the
// served bytes, the cdp-url event naming the tab, and Rustdoc's own search
// results read back through the copy bridge.
//
// Isolated: private data dir, boop store, tmux dir, no globals, no owner Chrome
// profile (the config precreates <data-dir>/cdp-chrome/Default so cdp.rs never
// clones the real one). No e2e-real/0_real.ts helpers, no stub boop.
import { expect, test, type Page } from "@playwright/test";

const port = Number(process.env.INSTANT_RUSTDOC_PORT ?? 47816);
const noRootPort = Number(process.env.INSTANT_RUSTDOC_NOROOT_PORT ?? 47817);

type EventFrame = { event: string; payload: Record<string, unknown> };

/// Minimal JSON-RPC client over the app's own /ws: subscribe to events and send
/// cdp_send. Node's global WebSocket is enough; no fixture transport.
class Rpc {
  ws: WebSocket;
  events: EventFrame[] = [];
  pending: ((frame: EventFrame) => boolean)[] = [];
  private nextId = 1;
  private calls = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (message) => {
      const data = typeof message.data === "string" ? message.data : "";
      let frame: {
        id?: number;
        method?: string;
        result?: unknown;
        error?: { message?: string };
        params?: { event?: string; payload?: unknown };
      };
      try {
        frame = JSON.parse(data);
      } catch {
        return;
      }
      // A request/response frame carries an id and result or error.
      if (typeof frame.id === "number" && (frame.result !== undefined || frame.error !== undefined)) {
        const call = this.calls.get(frame.id);
        if (call) {
          this.calls.delete(frame.id);
          if (frame.error) call.reject(new Error(frame.error.message ?? "rpc error"));
          else call.resolve(frame.result);
        }
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

  /// One request/response round trip over the same /ws the app speaks.
  call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new Error(`rpc ${method} timed out`));
      }, timeoutMs);
      this.calls.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
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

async function boot(page: Page, atPort = port): Promise<void> {
  await page.goto(`http://127.0.0.1:${atPort}/?ws=ws://127.0.0.1:${atPort}/ws`);
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

  // A literal percent in a filename survives the single decode boundary.
  expect((await request.get("/rustdoc/percent%25name.html")).status()).toBe(200);
  expect(await (await request.get("/rustdoc/percent%25name.html")).text()).toContain("percent");

  expect((await request.get("/rustdoc/does-not-exist.html")).status()).toBe(404);
  expect((await request.get("/rustdoc/..%2f..%2fCargo.toml")).status()).toBe(404);
  expect((await request.get("/rustdoc/%2e%2e%2fCargo.toml")).status()).toBe(404);
});

test("declines when no doc root is configured", async ({ page }) => {
  await boot(page, noRootPort);
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "P", code: "KeyP", metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  });
  await page.locator(".cmdp-input").fill("Rustdoc");
  await page.locator(".cmdp-input").press("Enter");

  await expect(page.locator(".app-toast")).toContainText("no documentation root", { timeout: 10_000 });
  await page.waitForTimeout(1_000);
  expect(await page.locator(".term-host").count()).toBe(0);
});

test("maps a selected target/doc page to its own loopback origin", async ({ request }) => {
  const rpc = await Rpc.connect();
  try {
    const docRoot = String((test.info().config.metadata as Record<string, unknown>).docRoot);
    const url = await rpc.call<string>("rustdoc_open", { path: `${docRoot}/docprobe/index.html` });
    expect(url).toContain("http://127.0.0.1:");
    expect(url).toContain("/docprobe/index.html");
    // No raw space survived into the path (the scratch root contains one).
    expect(new URL(url).pathname).not.toContain(" ");

    const served = await request.get(url);
    expect(served.status()).toBe(200);
    expect(await served.text()).toContain("docprobe");
    expect((await request.get(`${new URL(url).origin}/missing.html`)).status()).toBe(404);
    expect((await request.get(`${new URL(url).origin}/..%2f..%2fCargo.toml`)).status()).toBe(404);

    // A plain HTML file is declined so the normal file-open path can continue.
    expect(await rpc.call<string | null>("rustdoc_open", { path: "/etc/hosts" })).toBeNull();
  } finally {
    rpc.close();
  }
});

test("opens a generated index.html through the normal file-open flow", async ({ page }) => {
  await boot(page);
  const flatRoot = String((test.info().config.metadata as Record<string, unknown>).flatRoot);
  const rpc = await Rpc.connect();
  try {
    // ⌘⇧J is the app's "open a path" entry; typing an absolute path runs the same
    // click ladder a terminal ⌘-click uses, ending in openPathInInstant. The
    // HTML page must land in the embedded browser on the loopback doc origin,
    // not in a code preview or a file:// tab.
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "J", code: "KeyJ", metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    });
    await page.locator(".cmdp-input").fill(`${flatRoot}/flatprobe/index.html`);
    await page.locator(".cmdp-input").press("Enter");

    await expect(page.locator(".term-host").last()).toBeVisible({ timeout: 60_000 });
    const opened = await rpc.wait((frame) => frame.event === "cdp-frame" && String(frame.payload.id).includes("127.0.0.1"));
    const id = String(opened.payload.id);
    const loaded = await readInTab(rpc, id, `({ title: document.title, protocol: location.protocol, path: location.pathname })`);
    expect(loaded.protocol).toBe("http:");
    expect(String(loaded.title)).toBe("FlatDoc");
    expect(String(loaded.path)).toContain("flatprobe/index.html");
    expect(String(loaded.path)).not.toContain(" ");
  } finally {
    rpc.close();
  }
});

test("opens generated docs in the embedded browser and runs Rustdoc search", async ({ page }) => {
  await boot(page);
  const rpc = await Rpc.connect();
  try {
    // The palette opens the most recently registered root. Register the target
    // root first so the test does not depend on whether an earlier test opened
    // a different tree.
    const docRoot = String((test.info().config.metadata as Record<string, unknown>).docRoot);
    await rpc.call<string>("rustdoc_open", { path: `${docRoot}/docprobe/index.html` });

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
    // The palette now opens the loopback doc origin, not the frontend origin.
    const opened = await rpc.wait((frame) => frame.event === "cdp-frame" && String(frame.payload.id).includes("127.0.0.1"));
    const id = String(opened.payload.id);
    expect(id).toContain("127.0.0.1");

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

    // Back navigation returns to the crate page through the browser history.
    rpc.send({
      jsonrpc: "2.0",
      id: 2,
      method: "cdp_send",
      params: { id, method: "Runtime.evaluate", params: { expression: `history.back()` } },
    });
    await rpc.wait((frame) => frame.event === "cdp-url" && String(frame.payload.url).includes("docprobe/index.html"));
    const back = await readInTab(rpc, id, `({ title: document.title })`);
    expect(String(back.title)).toContain("docprobe");
  } finally {
    rpc.close();
  }
});
