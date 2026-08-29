// E2E bootstrap for ⌘-click routing: one static node per surface the router
// listens to. Path resolution is Rust, so the resolver is stubbed out here.
import "../src/styles.css";
import { cmdClickRouter, wireDomCmdClick } from "../src/clickrules";

const HOME = "/tmp/ladder-home";
const REPO = `${HOME}/projects/instant`;
const CWD = `${REPO}/src`;

type E2eWindow = Window & {
  __instantE2eNativeResults?: Record<string, unknown>;
  __cmdClickEvents?: Array<{ token: string; cwd: string; source: string; routeId: string | null }>;
  __runClickArgs?: Record<string, unknown>;
  __cwd?: string;
};

(window as E2eWindow).__instantE2eNativeResults = {
  // Resolution lives in Rust (src-tauri/src/refresolve.rs); these tests are about
  // which surface a ⌘-click comes from, so the resolver never runs.
  resolve_ref: { kind: "miss" },
  run_click: (args: Record<string, unknown> | undefined) => {
    (window as E2eWindow).__runClickArgs = args;
    return `src/preview.ts:12:const preview = 1\n`;
  },
  read_text: "line one\nline two\n",
};

const events: Array<{ token: string; cwd: string; source: string; routeId: string | null }> = [];
(window as E2eWindow).__cmdClickEvents = events;
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
