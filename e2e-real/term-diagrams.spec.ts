// Terminal diagrams against the real backend. Every pane is a real tmux
// session; the bytes the fixture wrote with a window hook are printed by the
// shell instead. Boop-located diagrams need turns in boop's store and a pane
// bound to that session, the way a lane registration binds one, so the app's
// own projection finds the source. Receipts are the overlay DOM, the context
// menu, the lightbox and tmux.
import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderConversationTurns } from "../scripts/3_claudeConversationReplay";
import {
  bindPaneSession, boot, burnClaimedPaneIds, cell, closeTabs, dropPaneSessions, dropSeededTurns,
  killAllSessions, menuRow, openSessionTab, paneScreen, screenRows, scrollPaneUp, seedTurnRows,
  shot, silentSessionPane, tmux, turnDebugOn, typeLine, visibleTurnIds,
} from "./0_real";

const TURN = 701;
const dirs: string[] = [];

const filler = (count: number, tag: string) => Array.from({ length: count }, (_, index) => `${tag} ${index}`);

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "term-diagrams-"));
  dirs.push(dir);
  return dir;
}

/// A pane holding nothing but `body`, on a session named once for this test.
async function plainPane(page: Page, body: string, marker: string): Promise<string> {
  await boot(page);
  return silentSessionPane(page, scratch(), body, marker);
}

/// A pane whose session boop's store also holds turns for, bound the way a lane
/// registration binds one. The turns are seeded before the pane paints them, so
/// the first scan after the write locates them.
async function turnPane(
  page: Page,
  turns: readonly { turn: number; role: string; said: string }[],
  body: string | ((rows: number) => string),
  marker: string,
): Promise<{ dir: string; session: string }> {
  const dir = scratch();
  await boot(page);
  burnClaimedPaneIds();
  const session = await silentSessionPane(page, dir, "diagram fixture ready\n", "diagram fixture ready");
  seedTurnRows(session, turns);
  bindPaneSession(session);
  const file = join(dir, "turn.txt");
  // A body sized from the pane fills the screen exactly, so its first and last
  // rows are the viewport edges.
  writeFileSync(file, typeof body === "function" ? body((await screenRows(page)).length) : body);
  typeLine(session, `clear; cat ${file}`);
  await expect.poll(() => paneScreen(session).join("\n"), { timeout: 20_000, message: `pane never showed ${marker}` })
    .toContain(marker);
  await page.waitForTimeout(1_000);
  return { dir, session };
}

/// A turn printed the way a harness prints it: the glyph on the first row, the
/// rest indented by two.
const rendered = (said: string) =>
  renderConversationTurns([{ role: "assistant", subtype: null, said }]).replace(/\r\n/g, "\n");

/// Right-click a terminal row and read the label the context menu puts on the
/// turn under the pointer.
async function ctxAt(page: Page, row: number, col = 4): Promise<void> {
  const at = await cell(page, row, col);
  await page.mouse.click(at.x, at.y, { button: "right" });
  await expect(page.locator(".ctx-menu")).toBeVisible({ timeout: 10_000 });
}

/// A viewport point inside the part of a diagram the terminal actually shows.
async function visibleDiagramPoint(diagram: ReturnType<Page["locator"]>) {
  return diagram.evaluate((element) => {
    const diagramRect = element.getBoundingClientRect();
    const screenRect = element.closest(".term-host")!.querySelector(".xterm-screen")!.getBoundingClientRect();
    return {
      x: Math.max(diagramRect.left, screenRect.left) + 20,
      y: (Math.max(diagramRect.top, screenRect.top) + Math.min(diagramRect.bottom, screenRect.bottom)) / 2,
    };
  });
}

/// Last visible row holding `text`. tmux paints its status line into the final
/// xterm row, so the bottom edge of the pane is the row above it.
function lastRowWith(rows: string[], text: string): number {
  for (let index = rows.length - 1; index >= 0; index -= 1) if (rows[index].includes(text)) return index;
  return -1;
}

/// The turn the debug overlay attributes one visible row to. The overlay paints
/// one row node per screen row, so the index is the screen row.
async function debugTurnIdAt(page: Page, row: number): Promise<string> {
  return page.evaluate((index) => {
    const host = [...document.querySelectorAll<HTMLElement>(".term-host")].find((h) => h.getBoundingClientRect().width > 0);
    const nodes = [...(host?.querySelectorAll<HTMLElement>(".term-turn-debug-row") ?? [])];
    return nodes[index]?.dataset.turnId ?? "";
  }, row);
}

async function rightClickDiagram(page: Page, diagram: ReturnType<Page["locator"]>): Promise<void> {
  const point = await visibleDiagramPoint(diagram);
  await page.mouse.click(point.x, point.y, { button: "right" });
}

// ---- fixture bytes, carried over from the fixture-page spec ----

const fencedOutput = (harness: "Codex" | "Claude Code") => [
  `${harness} response:`,
  "",
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
].join("\n");

// What the harness prints once it has rendered the same two fences: no
// backticks, no language label, the code indented under a bullet.
const renderedCliOutput = (harness: "Codex" | "Claude Code") => [
  `${harness} response:`,
  "",
  "• PTY -> tmux",
  "  tmux -> xterm",
  '  xterm -> "D2 renderer"',
  "",
  "  flowchart LR",
  "    PTY --> tmux",
  "    tmux --> xterm",
  "    xterm --> Mermaid",
  "",
].join("\n");

const cliTurnSaid = [
  "```d2",
  "PTY -> tmux",
  "tmux -> xterm",
  'xterm -> "D2 renderer"',
  "```",
  "",
  "```mermaid",
  "flowchart LR",
  "  PTY --> tmux",
  "  tmux --> xterm",
  "  xterm --> Mermaid",
  "```",
].join("\n");

const escapedLabelFlowchart = [
  "Codex response:",
  "",
  "```mermaid",
  "flowchart LR",
  '  parse["parse &lt; lex"] --> lower',
  '  lower --> emit["emit &lt; link"]',
  "  emit --> run",
  "  run --> report",
  "```",
  "",
].join("\n");

test.afterEach(async ({ page }) => {
  await closeTabs(page);
  dropSeededTurns();
  dropPaneSessions();
  killAllSessions();
});

test.afterAll(() => {
  killAllSessions();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("emits xterm geometry when its row and column count changes", async ({ page }) => {
  await boot(page);
  const session = await openSessionTab(page, scratch());
  const size = () => tmux(["display-message", "-p", "-t", `${session}:`, "#{window_width}x#{window_height}"]).trim();
  const before = size();
  const rowsBefore = (await screenRows(page)).length;
  expect(before).toMatch(/^\d+x\d+$/);

  // A smaller window is the user gesture; xterm refits, and the app pushes the
  // new cols and rows down to the pty, which is the tmux client.
  await page.setViewportSize({ width: 900, height: 560 });
  await expect.poll(size, { timeout: 20_000, message: `tmux window stayed ${before}` }).not.toBe(before);
  const rowsAfter = (await screenRows(page)).length;
  expect(rowsAfter).toBeLessThan(rowsBefore);
  const [colsBefore, heightBefore] = before.split("x").map(Number);
  const [colsAfter, heightAfter] = size().split("x").map(Number);
  expect(colsAfter).toBeLessThan(colsBefore);
  expect(heightAfter).toBeLessThan(heightBefore);
  await shot(page, "diagrams-01-geometry");
  await page.setViewportSize({ width: 1400, height: 900 });
});

test("emits Boop turn ids as terminal viewport contents change", async ({ page }) => {
  const first = [701, 702, 703];
  const second = [704, 705, 706];
  const said = (turn: number) => [
    `TURN ${turn} alpha line`,
    `TURN ${turn} beta line`,
    `TURN ${turn} gamma line`,
  ].join("\n");
  const turns = [...first, ...second].map((turn) => ({ turn, role: "assistant", said: said(turn) }));
  const body = first.map((turn) => rendered(said(turn))).join("\n");
  const { dir, session } = await turnPane(page, turns, body, "TURN 703 gamma line");
  await turnDebugOn(page);

  // One debug row per attributed screen row, so the ids are read as a set.
  const turnIds = async () => [...new Set(await visibleTurnIds(page))];
  await expect.poll(turnIds, { timeout: 30_000 })
    .toEqual(first.map((turn) => `${session}:${turn}`));

  // The pane paints the next three turns over the first three: the ids the app
  // attributes rows to change with the screen, with no gesture from the user.
  const next = join(dir, "next.txt");
  writeFileSync(next, second.map((turn) => rendered(said(turn))).join("\n"));
  typeLine(session, `clear; cat ${next}`);
  await expect.poll(turnIds, { timeout: 30_000 })
    .toEqual(second.map((turn) => `${session}:${turn}`));
  await shot(page, "diagrams-02-turn-ids");
});

test("right-click resolves partially visible turns at both viewport edges", async ({ page }) => {
  // Each turn holds more lines than the screen shows: the pane paints the tail
  // of the first and the head of the second, so both run past an edge.
  const top = ["TOP VISIBLE first line", ...filler(39, "TOP BODY")].join("\n");
  const bottom = ["BOTTOM START first line", ...filler(39, "BOTTOM BODY")].join("\n");
  const turns = [
    { turn: 711, role: "assistant", said: top },
    { turn: 712, role: "assistant", said: bottom },
  ];
  const body = (rows: number) => {
    // tmux paints its status line into the last xterm row, and the cursor needs
    // the row after the text.
    const lines = rows - 2;
    const half = Math.floor(lines / 2);
    return [
      ...rendered(top).split("\n").slice(-half),
      ...rendered(bottom).split("\n").slice(0, lines - half),
      "",
    ].join("\n");
  };
  const { session } = await turnPane(page, turns, body, "BOTTOM BODY");

  const rows = await screenRows(page);
  expect(rows[0]).toContain("TOP BODY");
  const bottomRow = lastRowWith(rows, "BOTTOM BODY");
  expect(bottomRow).toBeGreaterThanOrEqual(rows.length - 3);
  // The overlay names the turn each edge row belongs to before the pointer asks
  // for it, so the menu is opened on a settled projection.
  await turnDebugOn(page);
  await expect.poll(() => debugTurnIdAt(page, 0), { timeout: 30_000 }).toBe(`${session}:711`);
  await expect.poll(() => debugTurnIdAt(page, bottomRow), { timeout: 30_000 }).toBe(`${session}:712`);

  await ctxAt(page, 0);
  await expect(page.locator(".ctx-menu")).toContainText(`Boop ${session}:711 \u00b7 assistant`);
  await page.keyboard.press("Escape");
  await ctxAt(page, bottomRow);
  await expect(page.locator(".ctx-menu")).toContainText(`Boop ${session}:712 \u00b7 assistant`);
  await shot(page, "diagrams-03-edge-turns");
});

test("right-click distinguishes partial edge turns around a complete middle turn", async ({ page }) => {
  const top = ["TOP THREE VISIBLE line", ...filler(19, "TOP THREE BODY")].join("\n");
  const middle = ["MIDDLE START line", ...filler(8, "MIDDLE BODY"), "MIDDLE END line"].join("\n");
  const bottom = ["BOTTOM THREE START line", ...filler(19, "BOTTOM THREE BODY")].join("\n");
  const turns = [
    { turn: 721, role: "assistant", said: top },
    { turn: 722, role: "assistant", said: middle },
    { turn: 723, role: "assistant", said: bottom },
  ];
  const body = [rendered(top), rendered(middle), rendered(bottom)].join("\n");
  const { session } = await turnPane(page, turns, body, "BOTTOM THREE BODY 18");

  scrollPaneUp(session, 8);
  await page.waitForTimeout(2_500);
  const rows = await screenRows(page);
  expect(rows[0]).toContain("TOP THREE BODY");
  const bottomRow = lastRowWith(rows, "BOTTOM THREE BODY");
  expect(bottomRow).toBe(rows.length - 2);
  const middleRow = rows.findIndex((row) => row.includes("MIDDLE BODY 4"));
  expect(middleRow).toBeGreaterThan(0);
  await turnDebugOn(page);
  await expect.poll(() => debugTurnIdAt(page, 0), { timeout: 30_000 }).toBe(`${session}:721`);

  for (const entry of [{ row: 0, turn: 721 }, { row: middleRow, turn: 722 }, { row: bottomRow, turn: 723 }]) {
    await ctxAt(page, entry.row);
    await expect(page.locator(".ctx-menu")).toContainText(`Boop ${session}:${entry.turn} · assistant`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  }
  await shot(page, "diagrams-04-three-turns");
});

test("right-click resolves table turn with unicode box-drawing characters", async ({ page }) => {
  const said = [
    "Claude, OpenCode, Kimi, or another harness can implement the same generic lifecycle with their native APIs.",
    "",
    "## Concepts shared with the researched systems",
    "",
    "| Boop mechanism | Common systems concept |",
    "|---|---|",
    "| Inspecting WebSocket relay | Sidecar or transparent protocol proxy |",
    "| Unix domain sockets | Local IPC used by editors, language servers, daemons |",
    "| Request-ID correlation | JSON-RPC, LSP, DAP, ACP |",
  ].join("\n");
  // The harness draws the table with box-drawing rules instead of pipes; the
  // projection has to match those rows back to the markdown the turn holds.
  const body = [
    "Claude, OpenCode, Kimi, or another harness can implement the same generic lifecycle with their native APIs.",
    "",
    "  ## Concepts shared with the researched systems",
    "",
    "   Boop mechanism                       Common systems concept",
    "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "   Inspecting WebSocket relay           Sidecar or transparent protocol proxy",
    "  ───────────────────────────────────  ──────────────────────────────────────────────────────",
    "   Unix domain sockets                  Local IPC used by editors, language servers, daemons",
    "",
  ].join("\n");
  const { session } = await turnPane(page, [{ turn: 731, role: "assistant", said }], body, "Unix domain sockets");

  const rows = await screenRows(page);
  const row = rows.findIndex((line) => line.includes("Inspecting WebSocket relay"));
  expect(row).toBeGreaterThan(-1);
  await ctxAt(page, row);
  await expect(page.locator(".ctx-menu")).toContainText(`Boop ${session}:731 · assistant`);
  await shot(page, "diagrams-05-unicode-table");
});

for (const harness of ["Codex", "Claude Code"] as const) {
  const slug = harness.toLowerCase().replaceAll(" ", "-");

  test(`renders plain fenced Mermaid and D2 output from ${harness}`, async ({ page }) => {
    await plainPane(page, fencedOutput(harness), "tmux -> xterm");

    const diagrams = page.locator(".term-diagram");
    await expect(diagrams).toHaveCount(2, { timeout: 30_000 });
    await expect(page.locator('.term-diagram[data-language="mermaid"] svg')).toBeVisible();
    await expect(page.locator('.term-diagram[data-language="d2"] > svg')).toBeVisible();
    await expect(page.locator('.term-diagram[data-language="mermaid"]')).toContainText("PTY");
    await expect(page.locator('.term-diagram[data-language="mermaid"]')).toContainText("xterm");
    await expect(page.locator('.term-diagram[data-language="d2"]')).toContainText("PTY");
    await expect(page.locator('.term-diagram[data-language="d2"]')).toContainText("xterm");
    const inlineBoxes = await page.locator(".term-diagram > svg").evaluateAll((svgs) => svgs.map((svg) => {
      const box = svg.getBoundingClientRect();
      return { width: Math.round(box.width), height: Math.round(box.height) };
    }));
    expect(inlineBoxes).toHaveLength(2);
    expect(inlineBoxes.every(({ width }) => width > 500)).toBe(true);
    expect(inlineBoxes.every(({ height }) => height > 0)).toBe(true);

    await rightClickDiagram(page, page.locator('.term-diagram[data-language="d2"]'));
    await (await menuRow(page, "Expand D2 diagram")).click();
    const expanded = page.locator('.diagram-lightbox[data-language="d2"]');
    await expect(expanded).toBeVisible();
    await expect(expanded).toContainText("PTY");
    await expect(expanded.getByTitle(/zoom in/i)).toBeVisible();
    await expect(expanded.getByTitle("fit the complete SVG")).toBeVisible();
    const svgObject = expanded.locator(".diagram-vector-stage > svg");
    await expect(svgObject).toHaveAttribute("viewBox", /\S+/);
    const beforeZoom = await svgObject.getAttribute("viewBox");
    await expanded.getByTitle(/zoom in/i).click();
    await expect.poll(() => svgObject.getAttribute("viewBox")).not.toBe(beforeZoom);
    await expect(expanded.locator(".panzoom-canvas")).toHaveCount(0);
    await shot(page, `diagrams-06-${slug}-lightbox`);

    await page.keyboard.press("Escape");
    await expect(expanded).toHaveCount(0);
    await expect(page.locator(".term-host").first()).toBeVisible();
    await expect(diagrams).toHaveCount(2);
    await expect(page.locator('.term-diagram[data-language="mermaid"]')).toContainText("PTY");
    await expect(page.locator('.term-diagram[data-language="d2"]')).toContainText("PTY");
    await shot(page, `diagrams-07-${slug}-inline`);
  });

  test(`matches ${harness} viewport lines to Boop Mermaid and D2 regions`, async ({ page }) => {
    const { session } = await turnPane(
      page,
      [{ turn: TURN, role: "assistant", said: cliTurnSaid }],
      renderedCliOutput(harness),
      "xterm --> Mermaid",
    );

    const mermaid = page.locator('.term-diagram[data-language="mermaid"]');
    const d2 = page.locator('.term-diagram[data-language="d2"]');
    await expect(mermaid.locator("svg")).toBeVisible({ timeout: 30_000 });
    await expect(d2.locator("> svg")).toBeVisible();
    await expect(d2).toContainText("D2 renderer");
    await expect(mermaid).toContainText("Mermaid");
    // The source came from the turn, not from the pane: only the ledger holds
    // the fences the harness already stripped.
    await expect(mermaid).toHaveAttribute("data-diagram-locator", `boop:${session}:${TURN}`);
    await expect(d2).toHaveAttribute("data-diagram-locator", `boop:${session}:${TURN}`);
    const allocation = await mermaid.evaluate((element) => ({
      sourceRows: Number((element as HTMLElement).dataset.sourceRows),
      allocatedRows: Number((element as HTMLElement).dataset.allocatedRows),
    }));
    expect(allocation.allocatedRows).toBeGreaterThan(allocation.sourceRows);
    await shot(page, `diagrams-08-${slug}-boop-regions`);
  });
}

test("wheel routes to tmux copy-mode without moving xterm scrollback", async ({ page }) => {
  // History under the fence gives the wheel somewhere to go: `clear` drops the
  // pane's history, so the body prints its own.
  const body = [...filler(60, "history line"), "", fencedOutput("Claude Code")].join("\n");
  const session = await plainPane(page, body, "tmux -> xterm");
  const diagram = page.locator('.term-diagram[data-language="mermaid"]');
  await expect(diagram.locator("svg")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1_000);

  const scrollTop = () => page.evaluate(() => {
    const host = [...document.querySelectorAll<HTMLElement>(".term-host")].find((h) => h.getBoundingClientRect().width > 0)!;
    return host.querySelector<HTMLElement>(".xterm-viewport")!.scrollTop;
  });
  const before = await scrollTop();
  const point = await visibleDiagramPoint(diagram);
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, -100);

  // The gesture goes to tmux: the pane enters copy-mode and its history moves,
  // while xterm's own scrollback stays where it was.
  await expect.poll(() => tmux(["display-message", "-p", "-t", `${session}:`, "#{pane_in_mode}"]).trim(), {
    timeout: 15_000,
    message: "pane never entered copy-mode",
  }).toBe("1");
  expect(await scrollTop()).toBe(before);
  await expect(page.locator(".term-diagrams")).toBeVisible();
  await expect(page.locator(".term-diagram")).toHaveCount(2);
  await expect(diagram).toContainText("PTY");
  await shot(page, "diagrams-09-wheel-copy-mode");
});

test("renders explicit terminal fences while Boop has no matching visible turn", async ({ page }) => {
  // No turns in the store and no binding: the pane's own rows are the source.
  const body = [
    "Codex response:",
    "",
    "mermaid",
    "flowchart LR",
    "  PTY --> tmux",
    "  tmux --> xterm",
    "",
    "d2",
    "PTY -> tmux",
    "tmux -> xterm",
    "",
  ].join("\n");
  await plainPane(page, body, "tmux -> xterm");

  await expect(page.locator(".term-diagram")).toHaveCount(2, { timeout: 30_000 });
  await expect(page.locator('.term-diagram[data-language="mermaid"] svg')).toBeVisible();
  await expect(page.locator('.term-diagram[data-language="d2"] > svg')).toBeVisible();
  await expect(page.locator('.term-diagram[data-language="mermaid"]'))
    .toHaveAttribute("data-diagram-locator", "terminal buffer");
  await shot(page, "diagrams-10-stripped-fences");
});

test("renders a stripped Claude timeline while Boop has no matching visible turn", async ({ page }) => {
  const body = [
    "Committed 43d8cad6",
    "",
    "mermaid",
    "timeline",
    "    title strings-to-ids across the generations",
    "    v1 : invented it, strings(id, value UNIQUE) + fact tables with ONLY integer FKs : CREATE VIEW auto-joins every column back to text",
    "    v2 : verbatim port, intact",
    "    v3 : port + mutations table, intact",
    "    v4 : fact store keeps it (view downgraded to TEMP) : NEW runtime_graph subsystem skips it, view deferred, never lands",
    "    v5 early : dropped by deliberate doctrine",
    "    v5 now : revived 2026-07-12, interned BY DEFAULT, rel_name_txt views live at HEAD today",
    "    v6 : new compiler born without it, task 4 queued",
    "",
    "Three things worth keeping from the dig:",
    "",
  ].join("\n");
  await plainPane(page, body, "v6 : new compiler born");

  const timeline = page.locator('.term-diagram[data-language="mermaid"]');
  await expect(timeline.locator("svg")).toBeVisible({ timeout: 30_000 });
  await expect(timeline).toContainText("strings-to-ids across the generations");
  await expect(timeline).toContainText("v6");
  await shot(page, "diagrams-11-timeline");
});

test("opens a viewport-tall D2 target and retains clicked source entries", async ({ page }) => {
  const d2Lines = Array.from({ length: 28 }, (_, index) => `node_${index} -> node_${index + 1}: step ${index + 1}`);
  const body = [
    "Codex response:",
    "",
    "```d2",
    ...d2Lines,
    "```",
    "```mermaid",
    "flowchart LR",
    "  source --> preview",
    "```",
    "",
  ].join("\n");
  await plainPane(page, body, "source --> preview");

  const d2 = page.locator('.term-diagram[data-language="d2"]');
  await expect(d2.locator("> svg")).toBeVisible({ timeout: 30_000 });
  const d2Point = await visibleDiagramPoint(d2);
  await page.mouse.click(d2Point.x, d2Point.y);

  const lightbox = page.locator('.diagram-lightbox[data-language="d2"]');
  await expect(lightbox).toBeVisible();
  await expect(lightbox.getByText("1/1", { exact: true })).toBeVisible();
  await lightbox.locator(".diagram-lightbox-debug summary").click();
  await expect(lightbox.locator(".diagram-lightbox-debug")).toContainText("terminal buffer");
  await expect(lightbox.locator(".diagram-lightbox-debug pre")).toContainText("node_0 -> node_1");
  await lightbox.getByTitle("Copy diagram source").click();
  await expect(lightbox.getByTitle("Copy diagram source")).toHaveText("Copied");
  await page.keyboard.press("Escape");

  const mermaid = page.locator('.term-diagram[data-language="mermaid"]');
  await expect(mermaid).toBeVisible();
  await rightClickDiagram(page, mermaid);
  await (await menuRow(page, "Expand Mermaid diagram")).click();
  const second = page.locator('.diagram-lightbox[data-language="mermaid"]');
  await expect(second.getByText("2/2", { exact: true })).toBeVisible();
  const mermaidSvg = second.locator(".diagram-vector-stage > svg");
  const mermaidViewBox = await mermaidSvg.getAttribute("viewBox");
  await second.getByTitle(/zoom in/i).click();
  await expect.poll(() => mermaidSvg.getAttribute("viewBox")).not.toBe(mermaidViewBox);
  await expect(second.locator(".panzoom-canvas")).toHaveCount(0);
  await second.getByTitle("Previous clicked diagram").click();
  await expect(page.locator('.diagram-lightbox[data-language="d2"]')).toBeVisible();
  await expect(page.locator(".diagram-lightbox-debug pre")).toContainText("node_27 -> node_28");
  await shot(page, "diagrams-12-lightbox-history");
});

test("does not infer D2 from Rust return types and arrow comments", async ({ page }) => {
  const body = [
    "struct Pair(u64);                    // (u:u32)<<32 | v:u32",
    "impl Pair { fn new(u:u32,v:u32)->Self; fn u(&self)->u32; fn v(&self)->u32 }",
    "struct Loaded { edges:u64, index: FxHashMap<u32, Vec<u32>>, // y -> [z]",
    "derived: FxHashSet<Pair>, delta: Vec<Pair> }",
    "",
    "trait Operator { fn on_batch(&mut self, rows: &[Pair], out: &mut Vec<Pair>); }",
    "struct Node { op: Box<dyn Operator>, downstream: Vec<usize> }",
    "",
  ].join("\n");
  await plainPane(page, body, "trait Operator");

  await page.waitForTimeout(3_000);
  await expect(page.locator(".term-diagram")).toHaveCount(0);
  await shot(page, "diagrams-13-no-rust-inference");
});

// The fixture held the boop_turns promise open from the page and asserted the
// stripped fence stayed unrendered until it resolved. The real backend answers
// from boop's sqlite with no handle the browser can stall, so the wait window
// has no receipt a user could see.
test.fixme("waits for slow Boop turns before rendering fence-stripped Mermaid", async () => {});

test("keeps later scrolled prose outside the Boop Mermaid source", async ({ page }) => {
  const said = [
    "```mermaid",
    "flowchart LR",
    "  PTY --> tmux",
    "  tmux --> xterm",
    "  xterm --> Mermaid",
    "```",
  ].join("\n");
  // Prose lands under the diagram with no blank row between: the rows read as
  // one block, and only the turn says where the diagram ends.
  const body = [
    "Codex response:",
    "  flowchart LR",
    "    PTY --> tmux",
    "    tmux --> xterm",
    "    xterm --> Mermaid",
    "This prose arrived later without a blank separator (click)",
    "",
  ].join("\n");
  const { session } = await turnPane(page, [{ turn: 741, role: "assistant", said }], body, "This prose arrived later");

  const mermaid = page.locator('.term-diagram[data-language="mermaid"]');
  await expect(mermaid.locator("svg")).toBeVisible({ timeout: 30_000 });
  await expect(mermaid).toHaveAttribute("data-diagram-locator", `boop:${session}:741`);
  await expect(mermaid).toContainText("PTY");
  await expect(mermaid).toContainText("Mermaid");
  await expect(mermaid).not.toContainText("This prose arrived later");
  await expect(mermaid).not.toHaveClass(/term-diagram-error/);
  await shot(page, "diagrams-14-scrolled-prose");
});

test("renders full Boop diagrams when the viewport contains only one source line", async ({ page }) => {
  const { session } = await turnPane(
    page,
    [{ turn: 751, role: "assistant", said: cliTurnSaid }],
    ["Codex response:", "", "tmux -> xterm", "", "PTY --> tmux", ""].join("\n"),
    "PTY --> tmux",
  );

  const d2 = page.locator('.term-diagram[data-language="d2"]');
  const mermaid = page.locator('.term-diagram[data-language="mermaid"]');
  await expect(d2).toContainText("D2 renderer", { timeout: 30_000 });
  await expect(mermaid).toContainText("Mermaid");
  await expect(d2).toHaveAttribute("data-diagram-locator", `boop:${session}:751`);
  await expect(mermaid).toHaveAttribute("data-diagram-locator", `boop:${session}:751`);
  await shot(page, "diagrams-15-one-source-line");
});

test("counts projected physical rows when wrapped Boop lines reach the viewport bottom", async ({ page }) => {
  // A node label wider than the terminal wraps onto a second physical row. The
  // allocation has to count rows the buffer holds, not lines the source has.
  const wide = `wrap ${"x".repeat(200)} end`;
  const code = ["flowchart LR", `  first["${wide}"] --> second`, "  second --> third"];
  const said = ["```mermaid", ...code, "```"].join("\n");
  const { session } = await turnPane(
    page,
    [{ turn: 761, role: "assistant", said }],
    [...filler(4, "top filler"), "", ...code, ""].join("\n"),
    "second --> third",
  );

  const mermaid = page.locator('.term-diagram[data-language="mermaid"]');
  await expect(mermaid.locator("svg")).toBeVisible({ timeout: 30_000 });
  await expect(mermaid).toHaveAttribute("data-diagram-locator", `boop:${session}:761`);
  const rows = await screenRows(page);
  const first = rows.findIndex((row) => row.includes("flowchart LR"));
  const last = rows.findIndex((row) => row.includes("second --> third"));
  expect(first).toBeGreaterThan(-1);
  expect(last).toBeGreaterThan(first);
  const physicalRows = last - first + 1;
  // The wrapped label costs an extra physical row over the three source lines.
  expect(physicalRows).toBeGreaterThan(code.length);
  await expect(mermaid).toHaveAttribute("data-source-rows", String(physicalRows));
  await shot(page, "diagrams-16-wrapped-rows");
});

test("keeps a committed diagram visible while new PTY text is arriving", async ({ page }) => {
  const { session } = await turnPane(
    page,
    [{ turn: 771, role: "assistant", said: cliTurnSaid }],
    renderedCliOutput("Codex"),
    "xterm --> Mermaid",
  );
  const mermaid = page.locator('.term-diagram[data-language="mermaid"]');
  await expect(mermaid).toContainText("Mermaid", { timeout: 30_000 });
  await page.waitForTimeout(1_500);

  const watch = page.evaluate(() => new Promise<{ hidden: number; mutations: number; sameElement: boolean }>((resolve) => {
    const host = [...document.querySelectorAll<HTMLElement>(".term-host")].find((h) => h.getBoundingClientRect().width > 0)!;
    const root = host.querySelector<HTMLElement>(".term-diagrams")!;
    const before = host.querySelector<HTMLElement>('.term-diagram[data-language="mermaid"]')!;
    let hidden = 0;
    let mutations = 0;
    const observer = new MutationObserver((records) => { mutations += records.length; });
    observer.observe(root, { childList: true, subtree: true });
    const tick = setInterval(() => { if (root.hidden) hidden += 1; }, 50);
    setTimeout(() => {
      clearInterval(tick);
      observer.disconnect();
      resolve({
        hidden,
        mutations,
        sameElement: host.querySelector('.term-diagram[data-language="mermaid"]') === before,
      });
    }, 3_000);
  }));
  typeLine(session, "for i in $(seq 0 19); do printf '\\rworking %d' \"$i\"; sleep 0.05; done");
  expect(await watch).toEqual({ hidden: 0, mutations: 0, sameElement: true });

  // The same element rides a two-line scroll: it moves, it stays mounted, and
  // it keeps the key the projection gave it.
  const beforeScroll = await mermaid.evaluate((element) => ({
    key: (element as HTMLElement).dataset.diagramKey,
    top: element.getBoundingClientRect().top,
  }));
  scrollPaneUp(session, 2);
  await page.waitForTimeout(2_500);
  const afterScroll = await mermaid.evaluate((element) => ({
    key: (element as HTMLElement).dataset.diagramKey,
    top: element.getBoundingClientRect().top,
  }));
  expect(afterScroll.key).toBe(beforeScroll.key);
  expect(afterScroll.top).not.toBe(beforeScroll.top);
  await expect(page.locator(".term-diagrams")).toBeVisible();
  await shot(page, "diagrams-17-streaming");
});

test("renders a flowchart whose quoted labels carry escaped angle brackets", async ({ page }) => {
  await plainPane(page, escapedLabelFlowchart, "emit --> run");

  const mermaid = page.locator('.term-diagram[data-language="mermaid"]');
  await expect(mermaid.locator("svg")).toBeVisible({ timeout: 30_000 });
  await expect(mermaid).not.toHaveClass(/term-diagram-error/);
  await expect(mermaid).toContainText("parse < lex");
  await shot(page, "diagrams-18-escaped-labels");
});

test("names the failing request when the Mermaid bundle cannot be fetched", async ({ page }) => {
  // The bundle is fetched lazily at first paint, so a route installed before
  // the page loads is the same cut as a server that stopped after it.
  await page.route(/mermaid\.min/, (route) => route.abort("connectionrefused"));
  await plainPane(page, escapedLabelFlowchart, "emit --> run");

  const failed = page.locator(".term-diagram-error");
  await expect(failed).toBeVisible({ timeout: 30_000 });
  await expect(failed).toContainText("mermaid.min");
  await expect(failed).toContainText("did not load:");
  await expect(failed).not.toHaveText("Mermaid bundle failed to load");
  await shot(page, "diagrams-19-bundle-failure");
});
