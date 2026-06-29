// Browser navigation history: a persisted, deduped list of URLs the CDP browser
// tabs have visited. Fed by the global `cdp-url` listener (every navigation), so
// it captures link clicks, redirects and SPA pushState — not just typed URLs.
// The History panel reads it to recall a page into a fresh tab; per-tab back/
// forward lives in CdpView and uses the page's own session history, not this.

const HIST_KEY = "nav.history";
const CAP = 500; // keep the most-recent N; older entries fall off
const CHANGED = "nav-history-changed";

export interface HistEntry {
  url: string;
  ts: number; // last-visited epoch ms (entries are deduped to most recent)
}

function load(): HistEntry[] {
  try {
    const v = JSON.parse(localStorage.getItem(HIST_KEY) ?? "[]");
    return Array.isArray(v) ? (v as HistEntry[]) : [];
  } catch {
    return [];
  }
}

function save(list: HistEntry[]) {
  localStorage.setItem(HIST_KEY, JSON.stringify(list));
  window.dispatchEvent(new CustomEvent(CHANGED));
}

// Most-recent-first. The stored list is already in that order (newest unshifted).
export function history(): HistEntry[] {
  return load();
}

// Record a visit. Re-visiting an existing URL moves it to the front with a fresh
// timestamp rather than duplicating. about:/blank/empty are ignored.
export function recordVisit(url: string): void {
  const u = (url ?? "").trim();
  if (!u || u === "about:blank" || u.startsWith("chrome://")) return;
  const list = load().filter((e) => e.url !== u);
  list.unshift({ url: u, ts: Date.now() });
  if (list.length > CAP) list.length = CAP;
  save(list);
}

export function clearHistory(): void {
  save([]);
}

// Subscribe to history changes (panel live-refresh). Returns an unsubscribe fn.
export function onHistoryChange(fn: () => void): () => void {
  window.addEventListener(CHANGED, fn);
  return () => window.removeEventListener(CHANGED, fn);
}
