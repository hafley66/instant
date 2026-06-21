// Service worker: the only context allowed to reach the localhost endpoint
// (host_permissions covers it; a content script on an https page can't, due to
// mixed-content + CORS). Tab lifecycle is observed here directly; DOM events are
// relayed from the content script via runtime messaging.
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

// Selection / clipboard / DOM interactions relayed from content scripts.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && typeof msg.kind === "string") send(msg);
});

// ---- tab lifecycle: what opened, switched, closed, and WHY a tab opened ----

// A tab was created. openerTabId tells us it was spawned from another tab.
chrome.tabs.onCreated.addListener((tab) => {
  const url = tab.pendingUrl || tab.url || "";
  const from = tab.openerTabId != null ? `opened from tab ${tab.openerTabId}` : "opened";
  send({ kind: "tabopen", url, title: tab.title || "", text: from });
});

// The real "why": a navigation in one tab spawned a new tab/target. This fires
// for ctrl-click, target=_blank, and window.open — the source frame is the cause.
if (chrome.webNavigation && chrome.webNavigation.onCreatedNavigationTarget) {
  chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => {
    send({
      kind: "tabopen",
      url: d.url || "",
      title: "",
      text: `source tab ${d.sourceTabId}`,
    });
  });
}

// Switching to a tab (throttled — rapid Cmd+number cycling is noisy).
let lastSwitch = 0;
chrome.tabs.onActivated.addListener(({ tabId }) => {
  const now = Date.now();
  if (now - lastSwitch < 400) return;
  lastSwitch = now;
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) return;
    send({ kind: "tabswitch", url: tab.url || "", title: tab.title || "", text: "" });
  });
});

// Closing a tab.
chrome.tabs.onRemoved.addListener((tabId) => {
  send({ kind: "tabclose", url: "", title: "", text: `closed tab ${tabId}` });
});
