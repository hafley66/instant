// Navigation plugin: browser history you can recall into a fresh tab. The CDP
// browser tabs feed nav.ts on every URL change (global cdp-url listener in
// main()). This panel lists those visits, newest-first, filterable; clicking one
// opens it in a new browser tab. Per-tab back/forward lives in CdpView.
import { useEffect, useState } from "react";
import { registerPlugin } from "./plugin";
import { history as navHistory, clearHistory, onHistoryChange, type HistEntry } from "./nav";
import { relTime } from "./core";
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
        html: "",
        component: HistoryPanelV2,
      },
    ],
  });
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

function HistoryRow({ entry }: { entry: HistEntry }) {
  const { host, rest } = splitUrl(entry.url);
  return (
    <div className="nav-hist-row" title={entry.url} onClick={() => openBrowserTab(entry.url)}>
      <div className="nav-hist-host">
        {host}
        <span className="muted nav-hist-rest">{rest}</span>
      </div>
      <div className="muted nav-hist-time">{relTime(entry.ts)}</div>
    </div>
  );
}

export function HistoryPanelV2() {
  const [query, setQuery] = useState("");
  // navHistory() reads localStorage directly (no central store); re-render on
  // the nav-history-changed event, the same signal the vanilla version used.
  const [, bump] = useState(0);
  useEffect(() => onHistoryChange(() => bump((n) => n + 1)), []);

  const q = query.trim().toLowerCase();
  const all = navHistory();
  const rows = q ? all.filter((e) => e.url.toLowerCase().includes(q)) : all;

  return (
    <>
      <div className="act-bar">
        <span className="spy-title">history</span>
        <span className="wt-count">
          {rows.length ? `${rows.length} page${rows.length > 1 ? "s" : ""}` : ""}
        </span>
        <span className="spy-spacer" />
        <button type="button" onClick={() => clearHistory()}>
          Clear
        </button>
      </div>
      <div className="wt-scan">
        <input
          autoComplete="off"
          spellCheck={false}
          placeholder="filter history…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </div>
      <div className="panel-scroll">
        {rows.length === 0 ? (
          <div className="session-empty">
            {q ? "no matching history" : "no history yet — visit a page in a browser tab"}
          </div>
        ) : (
          rows.map((e) => <HistoryRow key={e.url} entry={e} />)
        )}
      </div>
    </>
  );
}
