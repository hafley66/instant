import { execFileSync } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { chromium, expect, test } from "@playwright/test";

const repo = resolve(import.meta.dirname, "..");
const extensionDir = resolve(repo, "extension");
const ingestPort = 8787;

const rule = {
  id: "fixture-usage",
  host: "^127\\.0\\.0\\.1$",
  mode: "netcapture",
  request: { methods: ["GET"], url: "/api/usage" },
  response: {
    extract: {
      percent: "five_hour.utilization * 100",
      resets_at: "five_hour.resets_at",
    },
  },
  emit: {
    stream: "fixture.usage",
    schema: {
      type: "object",
      properties: {
        percent: { type: "number", title: "Usage percent" },
        resets_at: { type: "string", title: "Reset time" },
      },
    },
  },
  enabled: true,
};

function json(res: ServerResponse, body: unknown, status = 200) {
  const encoded = JSON.stringify(body);
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(encoded),
  });
  res.end(encoded);
}

test("MV3 rule captures a local page API and emits a typed metric", async () => {
  execFileSync("npm", ["run", "ext:build"], { cwd: repo, stdio: "inherit" });

  const events: Record<string, unknown>[] = [];
  let configRequests = 0;
  const server = createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      });
      res.end();
      return;
    }
    if (req.method === "GET" && req.url === "/config") {
      configRequests++;
      json(res, { revision: 1, rules: [rule] });
      return;
    }
    if (req.method === "POST" && (req.url === "/heartbeat" || req.url === "/ingest")) {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        if (req.url === "/ingest") events.push(JSON.parse(body) as Record<string, unknown>);
        json(res, { ok: true });
      });
      return;
    }
    json(res, { error: "missing fixture route" }, 404);
  });
  await new Promise<void>((resolveServer) => server.listen(ingestPort, "127.0.0.1", resolveServer));

  const context = await chromium.launchPersistentContext("", {
    headless: true,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
    ],
  });
  const page = await context.newPage();
  await page.route("**/fixture.html", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><body><main id="fixture">loading</main><script>
      fetch('/api/usage').then((response) => response.json()).then((data) => {
        document.querySelector('#fixture').textContent = String(data.five_hour.utilization);
      });
    </script></body>`,
  }));
  await page.route("**/api/usage", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      five_hour: { utilization: 0.42, resets_at: "2030-01-02T03:04:05Z" },
    }),
  }));

  try {
    await expect.poll(() => configRequests).toBeGreaterThan(0);
    await page.goto("http://127.0.0.1:4173/fixture.html");
    await expect(page.locator("#fixture")).toHaveText("0.42");
    await expect.poll(() => events.filter((event) => event.type === "rulematch")).toHaveLength(1);
    const emitted = events
      .filter((event) => event.type === "rulematch")
      .map((event) => ({ ...event, ts: "<timestamp>" }));
    expect(emitted).toMatchInlineSnapshot(`
      [
        {
          "matches": [
            {
              "percent": 42,
              "resets_at": "2030-01-02T03:04:05Z",
            },
          ],
          "ruleId": "fixture-usage",
          "schema": {
            "properties": {
              "percent": {
                "title": "Usage percent",
                "type": "number",
              },
              "resets_at": {
                "title": "Reset time",
                "type": "string",
              },
            },
            "type": "object",
          },
          "stream": "fixture.usage",
          "ts": "<timestamp>",
          "type": "rulematch",
          "url": "http://127.0.0.1:4173/fixture.html",
        },
      ]
    `);
  } finally {
    await context.close();
    await new Promise<void>((resolveServer, reject) => server.close((error) => error ? reject(error) : resolveServer()));
  }
});
