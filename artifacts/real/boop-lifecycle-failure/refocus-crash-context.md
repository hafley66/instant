# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: boop-lifecycle.spec.ts >> a lane and mail added while hidden appear on refocus
- Location: e2e-real/boop-lifecycle.spec.ts:140:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('.boop-panel')
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for locator('.boop-panel')

```

```yaml
- text: instant — summon
- button "Minimize"
- button "Maximize"
- button "Close"
- button "⛶ Shot"
- button "▾"
- button "☾"
- button "◇" [pressed]
- button "⏹" [pressed]
- button "⛭"
- button "☑" [pressed]
- button "P5"
- navigation:
  - button "tmux": tmux ▸
  - button "Worktrees"
  - button "Activity"
  - button "Boop"
  - button "Favorites": ★ Favorites
  - button "Config"
  - button "Status": ● Status
  - button "Rules": ⚑ Rules ▸
  - button "Files"
  - button "History"
  - button "Paint": 🎨 Paint
  - button "⇆ Collapse"
- text: tmux Boop ✕
- img
- text: "1 Boop: crashed Cannot read properties of null (reading 'clear') TypeError: Cannot read properties of null (reading 'clear') at e.break (http://127.0.0.1:47807/assets/RenderTargetSystem-B6l26sKu.js:3:2537) at e.buildEnd (http://127.0.0.1:47807/assets/RenderTargetSystem-B6l26sKu.js:398:3146) at Wt._buildInstructions (http://127.0.0.1:47807/assets/RenderTargetSystem-B6l26sKu.js:398:19388) at Wt._updateRenderGroups (http://127.0.0.1:47807/assets/RenderTargetSystem-B6l26sKu.js:398:18679) at Wt.render (http://127.0.0.1:47807/assets/RenderTargetSystem-B6l26sKu.js:398:17239) at _e.emit (http://127.0.0.1:47807/assets/RenderTargetSystem-B6l26sKu.js:1:1073) at kt.render (http://127.0.0.1:47807/assets/RenderTargetSystem-B6l26sKu.js:1:3154) at Object.f [as current] (http://127.0.0.1:47807/assets/main-y28w47YY.js:382:48027) at http://127.0.0.1:47807/assets/main-y28w47YY.js:382:49954 at Zc (http://127.0.0.1:47807/assets/chrome-DV_-NgX0.js:73:91966)"
- button "Retry"
- button "STFU"
- status
```

# Test source

```ts
  54  |   await expect(page.locator(".boop-panel")).toBeHidden({ timeout: 10_000 });
  55  |   await page.locator('.dv-tab:has(.dv-default-tab-content:text-is("Boop"))').click();
  56  |   await expect(page.locator(".boop-panel")).toBeVisible({ timeout: 10_000 });
  57  | }
  58  | 
  59  | function row(page: Page, lane: string) {
  60  |   return page.locator(".boop-panel .dtable-row", { has: page.locator("td", { hasText: lane }) }).first();
  61  | }
  62  | 
  63  | async function shot(page: Page, name: string): Promise<void> {
  64  |   fs.mkdirSync(shots, { recursive: true });
  65  |   await page.screenshot({ path: path.join(shots, `boop-lifecycle-${name}.png`), fullPage: false });
  66  | }
  67  | 
  68  | test("first mount shows seeded live lanes and mail rows", async ({ page }) => {
  69  |   resetStore();
  70  |   seedLane({ lane: ALPHA, parent: BETA, cwd: "/tmp/e2e-life/alpha", state: "live", goal: "alpha goal", spawnedTs: NOW - 60_000 });
  71  |   seedLane({ lane: BETA, cwd: "/tmp/e2e-life/beta", state: "live", goal: "beta goal", spawnedTs: NOW - 120_000 });
  72  |   seedLane({ lane: GAMMA, cwd: "/tmp/e2e-life/gamma", state: "live", goal: "gamma goal", spawnedTs: NOW - 180_000 });
  73  |   seedMail({ id: "m-1", from: ALPHA, to: BETA, kind: "note", body: "alpha to beta", ageSec: 30 });
  74  |   seedMail({ id: "m-2", from: BETA, to: ALPHA, kind: "result", body: "beta result", ageSec: 10 });
  75  | 
  76  |   const errors = await boot(page);
  77  |   await openBoop(page);
  78  | 
  79  |   await expect(page.locator(".boop-panel .dtable-row")).toHaveCount(3, { timeout: 30_000 });
  80  |   await expect(row(page, ALPHA)).toBeVisible();
  81  |   await expect(row(page, BETA)).toBeVisible();
  82  |   await expect(row(page, GAMMA)).toBeVisible();
  83  |   await expect(row(page, ALPHA)).toContainText("e2e-life/alpha");
  84  | 
  85  |   await expect(page.locator(".boop-panel .empty-help")).toHaveCount(0);
  86  |   await expect(page.locator(".boop-panel")).not.toContainText("store read failed");
  87  |   await shot(page, "01-first-mount");
  88  |   expect(errors.page, errors.page.join("\n")).toEqual([]);
  89  | });
  90  | 
  91  | test("empty store shows a meaningful empty state, not a silent blank", async ({ page }) => {
  92  |   resetStore();
  93  |   await boot(page);
  94  |   await openBoop(page);
  95  | 
  96  |   const empty = page.locator(".boop-panel .empty-help");
  97  |   await expect(empty).toBeVisible({ timeout: 30_000 });
  98  |   await expect(empty).toContainText("no agents in the window");
  99  |   await expect(page.locator(".boop-panel")).not.toContainText("store read failed");
  100 |   await expect(page.locator(".boop-panel .dtable-row")).toHaveCount(0);
  101 |   await shot(page, "02-empty-store");
  102 | });
  103 | 
  104 | test("refocus after another tab keeps the rows and raises no error", async ({ page }) => {
  105 |   resetStore();
  106 |   seedLane({ lane: ALPHA, cwd: "/tmp/e2e-life/alpha", state: "live", goal: "alpha goal", spawnedTs: NOW - 60_000 });
  107 |   seedLane({ lane: BETA, cwd: "/tmp/e2e-life/beta", state: "live", goal: "beta goal", spawnedTs: NOW - 120_000 });
  108 |   seedMail({ id: "m-refocus", from: ALPHA, to: BETA, kind: "note", body: "refocus mail", ageSec: 20 });
  109 | 
  110 |   const errors = await boot(page);
  111 |   await openBoop(page);
  112 |   await expect(page.locator(".boop-panel .dtable-row")).toHaveCount(2, { timeout: 30_000 });
  113 | 
  114 |   await refocus(page);
  115 | 
  116 |   await expect(page.locator(".boop-panel .dtable-row")).toHaveCount(2, { timeout: 30_000 });
  117 |   await expect(row(page, ALPHA)).toBeVisible();
  118 |   await expect(row(page, BETA)).toBeVisible();
  119 |   await expect(page.locator(".boop-panel")).toHaveCount(1);
  120 |   await shot(page, "03-refocus");
  121 |   expect([...errors.page, ...errors.console], [...errors.page, ...errors.console].join("\n")).toEqual([]);
  122 | });
  123 | 
  124 | test("close and reopen the panel reloads the same rows", async ({ page }) => {
  125 |   resetStore();
  126 |   seedLane({ lane: ALPHA, cwd: "/tmp/e2e-life/alpha", state: "live", goal: "alpha goal", spawnedTs: NOW - 60_000 });
  127 |   const errors = await boot(page);
  128 |   await openBoop(page);
  129 |   await expect(page.locator(".boop-panel .dtable-row")).toHaveCount(1, { timeout: 30_000 });
  130 | 
  131 |   await page.locator("#boop-toggle").click();
  132 |   await expect(page.locator(".boop-panel")).toHaveCount(0);
  133 |   await openBoop(page);
  134 | 
  135 |   await expect(page.locator(".boop-panel .dtable-row")).toHaveCount(1, { timeout: 30_000 });
  136 |   await expect(row(page, ALPHA)).toBeVisible();
  137 |   expect([...errors.page, ...errors.console], [...errors.page, ...errors.console].join("\n")).toEqual([]);
  138 | });
  139 | 
  140 | test("a lane and mail added while hidden appear on refocus", async ({ page }) => {
  141 |   resetStore();
  142 |   seedLane({ lane: ALPHA, cwd: "/tmp/e2e-life/alpha", state: "live", goal: "alpha goal", spawnedTs: NOW - 60_000 });
  143 |   const errors = await boot(page);
  144 |   await openBoop(page);
  145 |   await expect(page.locator(".boop-panel .dtable-row")).toHaveCount(1, { timeout: 30_000 });
  146 | 
  147 |   // Hide Boop behind the tmux tab, then write to the scratch store.
  148 |   await page.locator('.dv-tab:has(.dv-default-tab-content:text-is("tmux"))').click();
  149 |   await expect(page.locator(".boop-panel")).toBeHidden();
  150 |   seedLane({ lane: BETA, cwd: "/tmp/e2e-life/beta", state: "live", goal: "beta goal", spawnedTs: NOW - 5_000 });
  151 |   seedMail({ id: "m-hidden", from: ALPHA, to: BETA, kind: "note", body: "while hidden", ageSec: 2 });
  152 | 
  153 |   await page.locator('.dv-tab:has(.dv-default-tab-content:text-is("Boop"))').click();
> 154 |   await expect(page.locator(".boop-panel")).toBeVisible();
      |                                             ^ Error: expect(locator).toBeVisible() failed
  155 |   await expect(page.locator(".boop-panel .dtable-row")).toHaveCount(2, { timeout: 30_000 });
  156 |   await expect(row(page, BETA)).toBeVisible();
  157 |   await shot(page, "05-updated-while-hidden");
  158 |   expect([...errors.page, ...errors.console], [...errors.page, ...errors.console].join("\n")).toEqual([]);
  159 | });
  160 | 
  161 | test("repeated refocus raises no errors and duplicates no rows", async ({ page }) => {
  162 |   resetStore();
  163 |   seedLane({ lane: ALPHA, cwd: "/tmp/e2e-life/alpha", state: "live", goal: "alpha goal", spawnedTs: NOW - 60_000 });
  164 |   const errors = await boot(page);
  165 |   await openBoop(page);
  166 |   await expect(page.locator(".boop-panel .dtable-row")).toHaveCount(1, { timeout: 30_000 });
  167 | 
  168 |   for (let i = 0; i < 5; i += 1) {
  169 |     await refocus(page);
  170 |     await expect(page.locator(".boop-panel .dtable-row")).toHaveCount(1, { timeout: 15_000 });
  171 |   }
  172 |   await expect(page.locator(".boop-panel")).toHaveCount(1);
  173 |   expect([...errors.page, ...errors.console], [...errors.page, ...errors.console].join("\n")).toEqual([]);
  174 | });
  175 | 
  176 | test("active-only default hides idle lanes; unfiltering shows them", async ({ page }) => {
  177 |   resetStore();
  178 |   seedLane({ lane: ALPHA, cwd: "/tmp/e2e-life/alpha", state: "live", goal: "live lane", spawnedTs: NOW - 60_000 });
  179 |   seedLane({ lane: GAMMA, cwd: "/tmp/e2e-life/gamma", state: "dead", goal: "done lane", spawnedTs: NOW - 300_000 });
  180 |   seedMail({ id: "m-dead", from: GAMMA, to: GAMMA, kind: "result", body: "done", ageSec: 240 });
  181 | 
  182 |   const errors = await boot(page);
  183 |   await openBoop(page);
  184 | 
  185 |   // Default: only the live root shows; the finished lane is counted as hidden.
  186 |   await expect(page.locator(".boop-panel .dtable-row")).toHaveCount(1, { timeout: 30_000 });
  187 |   await expect(row(page, ALPHA)).toBeVisible();
  188 |   await expect(row(page, GAMMA)).toHaveCount(0);
  189 |   await expect(page.locator(".boop-panel")).toContainText("1 hidden by active-only");
  190 | 
  191 |   // Unfiltered: the finished lane is present in the data, distinguishing a
  192 |   // lifecycle mount bug from the expected filter.
  193 |   await page.locator(".boop-panel input[type=checkbox]").click();
  194 |   await expect(page.locator(".boop-panel .dtable-row")).toHaveCount(2, { timeout: 15_000 });
  195 |   await expect(row(page, GAMMA)).toBeVisible();
  196 |   await shot(page, "07-active-only");
  197 |   expect([...errors.page, ...errors.console], [...errors.page, ...errors.console].join("\n")).toEqual([]);
  198 | });
  199 | 
```