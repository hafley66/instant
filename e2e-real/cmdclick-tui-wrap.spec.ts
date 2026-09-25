// The captured click: Claude's TUI hard-wrapped a lab directory mid-word, the
// continuation row carries prose after the fragment, and the path is relative
// to a repository beside the pane's own. ⌘-click on either row opens the lab.
import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import path from "node:path";
import { boot, closeTabs, cmdClickToken, gitIn, killAllSessions, mkRepo, openSessionTab, paneScreen, serveLog, shot, typeLine } from "./0_real";

const LAB = "labs/20260924.0.the-gang-runs-a-program-as-data-through-differential-dataflow/";
const HEAD = "  labs/20260924.0.the-gang-runs-a-program-as-data-t";
const TAIL = "  hrough-differential-dataflow/ is the lab dir.";
const dirs: string[] = [];

test.afterEach(async ({ page }) => {
  await closeTabs(page).catch(() => {});
  if (!process.env.INSTANT_E2E_KEEP) killAllSessions();
});

test.afterAll(() => {
  if (!process.env.INSTANT_E2E_KEEP) killAllSessions();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/// projects/{hafley-rs, sqlite_ivm} as two git repositories; the lab lives in
/// sqlite_ivm and the pane sits in hafley-rs.
function projects(): { paneRepo: string; lab: string } {
  const parent = mkRepo({});
  dirs.push(parent);
  const paneRepo = path.join(parent, "hafley-rs");
  const lab = path.join(parent, "sqlite_ivm", LAB);
  fs.mkdirSync(path.join(paneRepo, "crates"), { recursive: true });
  fs.writeFileSync(path.join(paneRepo, "README.md"), "pane repo\n");
  fs.mkdirSync(lab, { recursive: true });
  fs.writeFileSync(path.join(lab, "dd-circuit-notes.md"), "# circuit\n");
  gitIn(paneRepo, ["init", "-q", "-b", "main"]);
  gitIn(path.join(parent, "sqlite_ivm"), ["init", "-q", "-b", "main"]);
  return { paneRepo, lab };
}

async function printWrapped(page: Page, session: string): Promise<void> {
  typeLine(session, `clear; printf '%s\\r\\n' '${HEAD}' '${TAIL}'`);
  await expect
    .poll(() => paneScreen(session).filter((line) => line === HEAD || line === TAIL).length, {
      timeout: 15_000,
      message: `pane never painted the wrapped rows; screen: ${paneScreen(session).filter(Boolean).join(" | ")}`,
    })
    .toBe(2);
  await page.waitForTimeout(500);
}

for (const [name, fragment] of [["head", HEAD.trim()], ["tail", TAIL.trim().split(" ")[0]]] as const) {
  test(`⌘-click on the ${name} row of a TUI-wrapped sibling-repo path opens the lab`, async ({ page }) => {
    await boot(page);
    const { paneRepo, lab } = projects();
    const session = await openSessionTab(page, paneRepo);
    await printWrapped(page, session);

    const logFrom = serveLog().length;
    await cmdClickToken(page, session, fragment);
    const resolved = () => serveLog().slice(logFrom).split("\n").filter((line) => line.includes("resolve_ref"));

    await expect(page.locator(".dv-default-tab", { hasText: "Files" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("dd-circuit-notes.md").first()).toBeVisible({ timeout: 15_000 });
    // boop resolved the joined token from the pane's cwd to the sibling repo.
    await expect.poll(() => resolved().find((line) => line.includes(`token="${LAB}"`)) ?? resolved().join("\n"))
      .toContain('source="sibling"');
    expect(resolved().find((line) => line.includes(`token="${LAB}"`))).toContain(lab);
    await shot(page, `cmdclick-tui-wrap-${name}`);
  });
}
