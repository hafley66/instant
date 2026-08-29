// E2E bootstrap for ⌘-click routing: one static node per surface the router
// listens to, plus resolveRef on window so the path ladder is drivable directly.
import "../src/styles.css";
import { setHomeDir } from "../src/core";
import { cmdClickRouter, wireDomCmdClick } from "../src/clickrules";
import { resolveRef, type ResolveResult } from "../src/refResolve";

const HOME = "/tmp/ladder-home";
const REPO = `${HOME}/projects/instant`;
const SIBLING = `${HOME}/projects/instant-lanes`;
const CWD = `${REPO}/src`;

type E2eWindow = Window & {
  __instantE2eNativeResults?: Record<string, unknown>;
  __cmdClickEvents?: Array<{ token: string; cwd: string; source: string; routeId: string | null }>;
  __resolveRef?: (token: string, cwd: string) => Promise<ResolveResult>;
  __runClickArgs?: Record<string, unknown>;
  __cwd?: string;
};

const entry = (path: string, is_dir = false) => ({
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
  is_dir,
});

// Files under the repo root, as search_files reports them (files only).
const FILES = [
  `${REPO}/src/main.ts`,
  `${REPO}/src/preview.ts`,
  `${REPO}/src/mdview/MdPanel.tsx`,
  `${REPO}/e2e/MdPanel.tsx`,
  `${REPO}/packages/patchset-diff/src/index.ts`,
];

// Directories list_dir can answer for, which is what the crawl rungs probe.
const DIRS: Record<string, string[]> = {
  [HOME]: [`${HOME}/projects`, `${HOME}/TODO.md`],
  [`${HOME}/projects`]: [REPO, SIBLING],
  [SIBLING]: [`${SIBLING}/README.md`],
  [REPO]: [`${REPO}/src`, `${REPO}/e2e`, `${REPO}/packages`],
  [`${REPO}/src`]: [`${REPO}/src/main.ts`, `${REPO}/src/preview.ts`, `${REPO}/src/mdview`],
  [`${REPO}/src/mdview`]: [`${REPO}/src/mdview/MdPanel.tsx`],
  [`${REPO}/e2e`]: [`${REPO}/e2e/MdPanel.tsx`],
  [`${REPO}/packages`]: [`${REPO}/packages/patchset-diff`],
  [`${REPO}/packages/patchset-diff`]: [`${REPO}/packages/patchset-diff/src`],
};

setHomeDir(HOME);

(window as E2eWindow).__instantE2eNativeResults = {
  worktree_at: { worktree: REPO, branch: "main", head: "e2e", is_main: true },
  search_files: FILES.map((path) => entry(path)),
  list_dir: (args: Record<string, unknown> | undefined) => {
    const path = String(args?.path ?? HOME);
    const children = DIRS[path];
    if (!children) throw new Error(`ENOENT ${path}`);
    return { path, parent: path.slice(0, path.lastIndexOf("/")) || "/", entries: children.map((c) => entry(c, !!DIRS[c])) };
  },
  run_click: (args: Record<string, unknown> | undefined) => {
    (window as E2eWindow).__runClickArgs = args;
    return `src/preview.ts:12:const preview = 1\n`;
  },
  read_text: "line one\nline two\n",
};

const events: Array<{ token: string; cwd: string; source: string; routeId: string | null }> = [];
(window as E2eWindow).__cmdClickEvents = events;
(window as E2eWindow).__resolveRef = resolveRef;
(window as E2eWindow).__cwd = CWD;

// The app's routes open dock panels; this harness is a bare page, so the router
// records instead. Surface + token is the contract these tests assert.
cmdClickRouter.routes = [];
cmdClickRouter.register({
  id: "e2e-record",
  handle: ({ token, cwd, source }) => {
    events.push({ token, cwd, source, routeId: "e2e-record" });
    return true;
  },
});
cmdClickRouter.routed.subscribe(() => {});

document.getElementById("root")!.innerHTML = `
  <div class="fs-preview" data-testid="surface-preview">
    <div class="fs-preview-meta">preview surface</div>
    <pre>edited src/main.ts and packages/patchset-diff/src/index.ts today</pre>
  </div>
  <div class="rg-panel" data-testid="surface-results">
    <div class="rg-body"><div class="rg-plain">see ${REPO}/e2e/MdPanel.tsx for the copy</div></div>
  </div>
  <div class="v2-panel mdview-root" data-testid="surface-markdown">
    <div class="mdview-content"><div class="md-body"><p>the fix landed in src/preview.ts yesterday</p></div></div>
  </div>
  <div class="term-host" style="position: relative; width: 460px; height: 160px">
    <div class="term-diagrams" data-testid="surface-diagram">
      <div class="term-diagram" data-language="d2" style="inset: 10px">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 120" width="420" height="120">
          <rect width="420" height="120" fill="#101827"></rect>
          <text x="20" y="60" font-family="monospace" font-size="20" fill="#e5e7eb">src/main.ts -&gt; src/preview.ts</text>
        </svg>
      </div>
    </div>
  </div>
`;

wireDomCmdClick();
