// Service worker: the only context allowed to reach the localhost endpoint
// (host_permissions covers it; a content script on an https page can't, due to
// mixed-content + CORS). Tab navigation is observed here directly; selection /
// copy events are relayed from the content script via runtime messaging.
const ENDPOINT = "http://127.0.0.1:8787/ingest";

function send(ev) {
  // Fire-and-forget; the app may be closed (no server) and that's fine.
  fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ev),
  }).catch(() => {});
}

// One nav event per completed top-level load.
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (info.status === "complete" && tab.url && /^https?:/.test(tab.url)) {
    send({ kind: "nav", url: tab.url, title: tab.title || "", text: "" });
  }
});

// Selection / clipboard relayed from content scripts.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && typeof msg.kind === "string") send(msg);
});
