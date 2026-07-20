import { describe, expect, test, vi } from "vitest";
import {
  executeBrowserEffect,
  resolveBrowserContexts,
  type BrowserContext,
  type BrowserEffectsPort,
} from "./4_browserEffects";

const contexts: BrowserContext[] = [
  { id: 3, url: "https://claude.ai/new#settings/usage", active: false, lastAccessed: 1_000 },
  { id: 8, url: "https://claude.ai/new", active: true, lastAccessed: 4_000 },
  { id: 13, url: "https://example.com/", active: false, lastAccessed: 500 },
];

describe("browser effect target resolution", () => {
  test("matches URL, activity, idle duration, cardinality, and stable order", () => {
    expect(resolveBrowserContexts(contexts, {
      url: "^https://claude\\.ai/",
      active: false,
      idleForMs: 5_000,
      cardinality: "all",
    }, 10_000)).toMatchInlineSnapshot(`
      [
        {
          "active": false,
          "id": 3,
          "lastAccessed": 1000,
          "url": "https://claude.ai/new#settings/usage",
        },
      ]
    `);
  });

  test("reload emits a correlated result and defaults to one newest context", async () => {
    const reload = vi.fn(async () => undefined);
    const port: BrowserEffectsPort = { contexts: async () => contexts, reload };
    await expect(executeBrowserEffect({
      id: "refresh-claude",
      op: "browsingContext.reload",
      input: { target: { url: "^https://claude\\.ai/" }, ignoreCache: true },
    }, port, 10_000)).resolves.toMatchInlineSnapshot(`
      {
        "contexts": [
          8,
        ],
        "effectId": "refresh-claude",
        "op": "browsingContext.reload",
        "type": "browser.effect.next",
      }
    `);
    expect(reload.mock.calls).toMatchInlineSnapshot(`
      [
        [
          8,
          true,
        ],
      ]
    `);
  });

  test("unsupported and unmatched commands become error events", async () => {
    const port: BrowserEffectsPort = { contexts: async () => contexts, reload: async () => undefined };
    await expect(Promise.all([
      executeBrowserEffect({ id: "bad-op", op: "script.evaluate" }, port, 10_000),
      executeBrowserEffect({ id: "missing", op: "browsingContext.reload", input: { target: { url: "nomatch" } } }, port, 10_000),
    ])).resolves.toMatchInlineSnapshot(`
      [
        {
          "contexts": [],
          "effectId": "bad-op",
          "error": "Error: Unsupported browser effect: script.evaluate",
          "op": "script.evaluate",
          "type": "browser.effect.error",
        },
        {
          "contexts": [],
          "effectId": "missing",
          "error": "Error: No browser context matched the target",
          "op": "browsingContext.reload",
          "type": "browser.effect.error",
        },
      ]
    `);
  });
});
