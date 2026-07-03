// Navigation plugin: browser history you can recall into a fresh tab. The CDP
// browser tabs feed nav.ts on every URL change (global cdp-url listener in
// main()). This panel lists those visits, newest-first, filterable; clicking one
// opens it in a new browser tab. Per-tab back/forward lives in CdpView.
import { registerPlugin } from "./plugin";
import { history as navHistory, clearHistory, onHistoryChange } from "./nav";
import { escapeHtml, relTime } from "./core";
import { openBrowserTab } from "./browser";

export function registerNav() {
  registerPlugin({
    id: "nav",
    panels: [
      {
        id: "history",
        title: "History",
        icon: "↩",
        iconUrl: "/icons/Explorer100_32x32_4.png",
        iconLabel: "History",
        html: `<div class="act-bar">
          <span class="spy-title">history</span>
          <span id="nav-count" class="wt-count"></span>
          <span class="spy-spacer"></span>
          <button id="nav-clear" type="button">Clear</button>
        </div>
        <div class="wt-scan">
          <input id="nav-search" autocomplete="off" spellcheck="false" placeholder="filter history…" />
        </div>
        <div id="nav-history-body" class="panel-scroll"></div>`,
        onShow: () => renderHistoryPanel(),
      },
    ],
  });
  // Live-refresh while the panel is mounted (a visit in any tab updates the list).
  onHistoryChange(renderHistoryPanel);
}

// Split a URL into a host + path for two-line display. Falls back to the raw
// string for non-parseable entries (e.g. about:, data:).
function splitUrl(url: string): { host: string; rest: string } {
  try {
    const u = new URL(url);
    return { host: u.host || u.protocol, rest: (u.pathname + u.search).replace(/^\/$/, "") };
  } catch {
    return { host: url, rest: "" };
  }
}

function renderHistoryPanel() {
  const body = document.querySelector<HTMLElement>("#nav-history-body");
  if (!body) return; // panel detached; a later show re-renders
  const search = document.querySelector<HTMLInputElement>("#nav-search");
  const clear = document.querySelector<HTMLButtonElement>("#nav-clear");
  // Wire controls once (the html is injected once and reused across shows).
  if (search && !search.dataset.wired) {
    search.dataset.wired = "1";
    search.addEventListener("input", renderHistoryPanel);
    search.addEventListener("keydown", (e) => e.stopPropagation());
  }
  if (clear && !clear.dataset.wired) {
    clear.dataset.wired = "1";
    clear.onclick = () => clearHistory();
  }
  const q = (search?.value ?? "").trim().toLowerCase();
  const all = navHistory();
  const rows = q ? all.filter((e) => e.url.toLowerCase().includes(q)) : all;
  const count = document.querySelector<HTMLElement>("#nav-count");
  if (count) count.textContent = rows.length ? `${rows.length} page${rows.length > 1 ? "s" : ""}` : "";
  body.replaceChildren();
  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "session-empty";
    empty.textContent = q ? "no matching history" : "no history yet — visit a page in a browser tab";
    body.appendChild(empty);
    return;
  }
  for (const e of rows) {
    const { host, rest } = splitUrl(e.url);
    const row = document.createElement("div");
    row.className = "nav-hist-row";
    row.title = e.url;
    row.innerHTML =
      `<div class="nav-hist-host">${escapeHtml(host)}` +
      `<span class="muted nav-hist-rest">${escapeHtml(rest)}</span></div>` +
      `<div class="muted nav-hist-time">${relTime(e.ts)}</div>`;
    row.onclick = () => openBrowserTab(e.url);
    body.appendChild(row);
  }
}
