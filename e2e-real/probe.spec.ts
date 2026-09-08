// Probe: a fenced mermaid + d2 block cat'd into a real pane renders two
// diagrams in the visible host.
import { expect, test } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot, killAllSessions, openTab, shot, typeLine } from "./0_real";

test.afterAll(killAllSessions);

test("probe fenced diagrams", async ({ page }) => {
  await boot(page);
  const session = await openTab(page);
  const dir = mkdtempSync(join(tmpdir(), "instant-probe-"));
  const file = join(dir, "bytes.txt");
  writeFileSync(file, [
    "Codex response:",
    "```mermaid",
    "flowchart LR",
    "  PTY --> tmux",
    "  tmux --> xterm",
    "```",
    "",
    "```d2",
    "PTY -> tmux",
    "tmux -> xterm",
    "```",
    "",
  ].join("\n"));
  typeLine(session, `clear; cat ${file}`);
  await expect
    .poll(() => page.evaluate(() => {
      const host = [...document.querySelectorAll<HTMLElement>(".term-host")].find((h) => h.getBoundingClientRect().width > 0);
      return host?.querySelectorAll(".term-diagram").length ?? -1;
    }), { timeout: 15_000 })
    .toBe(2);
  await shot(page, "probe-01-diagrams");
});
