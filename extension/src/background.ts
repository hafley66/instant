// MV3 service worker. Owns everything that must reach the localhost server
// (host_permissions covers it; a content script on an https page can't, due to
// mixed-content + CORS). Three concerns:
//   1. Activity spy — tab lifecycle + relayed DOM events -> POST /ingest.
//   2. Config transport — GET /config each alarm tick; rules cached in storage.
//   3. Driven scans — chrome.alarms per scheduled rule reload+scrape a bg tab.
import type { MatchFields, Rule, RuleMatchEvent } from "./0_types";
import { paths } from "../../src/generated/api";
import { executeHttp } from "./httpTransport";

const CONFIG_ALARM = "config";
const DRIVEN_PREFIX = "driven:";

function send(ev: unknown) {
  // Fire-and-forget; the app may be closed (no server) and that's fine.
  executeHttp(
    paths.activityIngest.endpoint,
    ev as paths.activityIngest.Input,
  ).catch(() => {});
}

// ---------------------------------------------------------------------------
// 1. Activity spy — tab lifecycle + relayed DOM events (unchanged behavior).
// ---------------------------------------------------------------------------
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (info.status === "complete" && tab.url && /^https?:/.test(tab.url)) {
    send({ kind: "nav", url: tab.url, title: tab.title || "", text: "" });
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  const url = tab.pendingUrl || tab.url || "";
  const from = tab.openerTabId != null ? `opened from tab ${tab.openerTabId}` : "opened";
  send({ kind: "tabopen", url, title: tab.title || "", text: from });
});

if (chrome.webNavigation?.onCreatedNavigationTarget) {
  chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => {
    send({ kind: "tabopen", url: d.url || "", title: "", text: `source tab ${d.sourceTabId}` });
  });
}

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

chrome.tabs.onRemoved.addListener((tabId) => {
  send({ kind: "tabclose", url: "", title: "", text: `closed tab ${tabId}` });
});

// Relayed messages: activity events carry {kind}; rule hits carry {cmd:"rulematch"}.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (typeof msg.kind === "string") {
    send(msg);
  } else if (msg.cmd === "rulematch") {
    postRuleMatch(msg.ruleId, msg.url, msg.matches);
  }
});

function postRuleMatch(ruleId: string, url: string, matches: MatchFields[]) {
  const ev: RuleMatchEvent = { type: "rulematch", ruleId, url, ts: Date.now(), matches: matches || [] };
  send(ev);
}

// ---------------------------------------------------------------------------
// 2. Config transport — the server is the source of truth for rules.
// ---------------------------------------------------------------------------
async function refreshConfig(): Promise<Rule[]> {
  try {
    const cfg = await executeHttp(paths.activityConfig.endpoint, undefined);
    const rules = Array.isArray(cfg.rules) ? cfg.rules : [];
    await chrome.storage.local.set({ rules, rulesRevision: cfg.revision ?? 0 });
    await fetch("http://127.0.0.1:8787/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: cfg.revision ?? 0, rulesCount: rules.length }),
    }).catch(() => {});
    await armDrivenAlarms(rules);
    return rules;
  } catch {
    /* server down -> keep the cached rules */
  }
  const { rules } = await chrome.storage.local.get("rules");
  return Array.isArray(rules) ? (rules as Rule[]) : [];
}

async function setup() {
  chrome.alarms.create(CONFIG_ALARM, { periodInMinutes: 1 });
  await refreshConfig();
}

chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === CONFIG_ALARM) refreshConfig().catch(() => {});
  else if (a.name.startsWith(DRIVEN_PREFIX)) runDriven(a.name.slice(DRIVEN_PREFIX.length)).catch(() => {});
});

// ---------------------------------------------------------------------------
// 3. Driven scans — reload a dedicated bg tab per rule and scrape it.
// ---------------------------------------------------------------------------
function drivenRules(rules: Rule[]): Rule[] {
  return rules.filter(
    (r) =>
      r.enabled !== false &&
      r.url &&
      typeof r.schedule === "object" &&
      r.schedule != null &&
      typeof r.schedule.intervalMin === "number",
  );
}

async function armDrivenAlarms(rules: Rule[]) {
  const want = new Map(drivenRules(rules).map((r) => [DRIVEN_PREFIX + r.id, r]));
  const existing = await chrome.alarms.getAll();
  for (const al of existing) {
    if (al.name.startsWith(DRIVEN_PREFIX) && !want.has(al.name)) chrome.alarms.clear(al.name);
  }
  for (const [name, rule] of want) {
    const period = Math.max(1, (rule.schedule as { intervalMin: number }).intervalMin);
    chrome.alarms.create(name, { periodInMinutes: period });
  }
}

async function getDrivenTab(ruleId: string, targetUrl: string): Promise<chrome.tabs.Tab> {
  const key = `tab:${ruleId}`;
  const stored = await chrome.storage.local.get(key);
  const prev = stored[key] as number | undefined;
  if (prev != null) {
    try {
      return await chrome.tabs.get(prev);
    } catch {
      /* tab gone */
    }
  }
  const created = await chrome.tabs.create({ url: targetUrl, active: false });
  await chrome.storage.local.set({ [key]: created.id });
  return created;
}

function waitForLoad(tabId: number, timeoutMs = 20000): Promise<boolean> {
  return new Promise((resolve) => {
    const to = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(false);
    }, timeoutMs);
    function listener(id: number, info: chrome.tabs.OnUpdatedInfo) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(to);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function runDriven(ruleId: string) {
  const { rules } = await chrome.storage.local.get("rules");
  const rule = (rules as Rule[] | undefined)?.find((r) => r.id === ruleId);
  if (!rule || !rule.url) return;
  const tab = await getDrivenTab(ruleId, rule.url);
  if (tab.id == null) return;
  const cur = await chrome.tabs.get(tab.id);
  if (cur.url && cur.url.split("#")[0] === rule.url.split("#")[0]) {
    await chrome.tabs.reload(tab.id, { bypassCache: true });
  } else {
    await chrome.tabs.update(tab.id, { url: rule.url });
  }
  await waitForLoad(tab.id);
  // Scrape through the already-injected content script (host_permissions stays
  // 127.0.0.1 only; executeScript into an arbitrary host would need broad host
  // permission we deliberately don't take). The content script owns the scan.
  try {
    const matches = (await chrome.tabs.sendMessage(tab.id, {
      cmd: "drivenScan",
      ruleId,
    })) as MatchFields[] | undefined;
    if (matches && matches.length) postRuleMatch(ruleId, cur.url || rule.url, matches);
  } catch {
    /* content script not ready / tab closed */
  }
}
