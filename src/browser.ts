// Embedded browser tabs. These run in a shared headless Chrome over CDP: Rust
// streams the page's JPEG screencast to a canvas (`cdp-frame`), input/resize go
// back as CDP commands. They are NOT terminals — no xterm, no pty — but reuse the
// dockview panel lifecycle (addTermPanel/onTermShown/onTermClosed) keyed by the
// same id.
import { invoke } from "./generated/native";
import { store } from "./state";
import { CdpView, cdpQuality, setCdpQuality, QUALITY_STEPS, setCdpPerf } from "./cdp";
import { addTermPanel } from "./reactdock";
import { sessionId, flashStatus } from "./core";
import { activate, tabs } from "./terminal";
import { tabTitle } from "./tabs";
import { askText } from "./chrome";

export const browserTabs = new Map<
  string,
  { id: string; name: string; el: HTMLElement; view: CdpView }
>();

function normalizeUrl(s: string): string {
  if (!s) return "";
  if (/^[a-z]+:\/\//i.test(s) || s.startsWith("about:")) return s;
  if (/^\S+\.\S+/.test(s)) return "https://" + s;
  return "https://www.google.com/search?q=" + encodeURIComponent(s);
}

// Persist a browser tab so a reload reopens it (the CDP target survives a
// webview reload in the Rust CdpStore; a full restart re-creates it at the url).
function recordBrowserTab(name: string, url: string) {
  const cur = store.get().openTabs;
  if (cur.some((t) => t.name === name)) return;
  store.set({ openTabs: [...cur, { name, command: null, cwd: null, browser: true, url }] });
}

// Create the panel + CdpView for a browser tab with an explicit name (so the id
// is stable across reloads). Shared by the URL prompt and the boot replay.
export function spawnBrowserTab(name: string, u: string) {
  const id = sessionId(name);
  if (browserTabs.has(id) || tabs.has(id)) {
    activate(id);
    return;
  }
  const el = document.createElement("div");
  el.className = "term-host";
  document.getElementById("panel-pool")!.appendChild(el);
  const view = new CdpView(el, id, u);
  browserTabs.set(id, { id, name, el, view });
  recordBrowserTab(name, u); // survives reload
  addTermPanel(id, tabTitle(name), el); // dockview adopts el into the panel
  flashStatus("starting browser… (first run clones your Chrome profile)");
  // Measure after layout so the screencast starts at the panel's real size;
  // the view's ResizeObserver corrects any later drift.
  requestAnimationFrame(() => {
    const m = view.initialMetrics();
    invoke("cdp_open", {
      id, url: u, width: m.width, height: m.height, dpr: m.dpr, quality: cdpQuality(),
    }).catch((e) => {
      console.error(e);
      flashStatus("browser failed to start");
    });
    view.focus();
  });
}

export async function openBrowserTab(url?: string) {
  const raw = (url ?? (await askText("URL", "https://example.com")) ?? "").trim();
  if (!raw) return;
  spawnBrowserTab(`web:${raw}`, normalizeUrl(raw));
}

// Step the screencast JPEG quality to the next preset and re-apply it to every
// open browser tab live (cdp_resize restarts the screencast at the new quality).
export function cycleBrowserQuality() {
  const cur = cdpQuality();
  const idx = QUALITY_STEPS.findIndex((q) => q >= cur);
  const next = QUALITY_STEPS[(idx + 1) % QUALITY_STEPS.length];
  setCdpQuality(next);
  for (const { view } of browserTabs.values()) view.applyMetrics();
  flashStatus(`browser render quality: ${next}`);
}

// Flip performance mode (1x screencast) and re-apply to every open browser tab
// so the change takes effect live (cdp_resize restarts the screencast).
export function setBrowserPerf(on: boolean) {
  setCdpPerf(on);
  for (const { view } of browserTabs.values()) view.applyMetrics();
  flashStatus(`browser performance mode: ${on ? "on (1x)" : "off"}`);
}
