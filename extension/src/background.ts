// MV3 service worker. Owns everything that must reach the localhost server
// (host_permissions covers it; a content script on an https page can't, due to
// mixed-content + CORS). Three concerns:
//   1. Activity spy — tab lifecycle + relayed DOM events -> POST /ingest.
//   2. Config transport — GET /config each alarm tick; rules cached in storage.
//   3. Driven scans — chrome.alarms per scheduled rule reload+scrape a bg tab.
import type { JsonSchema, MatchFields, Rule, RuleMatchEvent } from "./0_types";
import { paths } from "../../src/generated/api";
import { executeHttp } from "./httpTransport";
import {
  createBrowserScheduleRuntime,
  isIntervalPipeSchedule,
  schedulePeriodMs,
  type BrowserScheduleRuntime,
} from "./5_scheduleRuntime";

const CONFIG_ALARM = "config";
const DRIVEN_PREFIX = "driven:";
const MIN_ALARM_MS = 30_000;

function send(ev: unknown) {
  // Fire-and-forget; the app may be closed (no server) and that's fine.
  executeHttp(
    paths.activityIngest.endpoint,
    ev as paths.activityIngest.Input,
  ).catch(() => {});
}

const browserSchedules = new Map<string, { signature: string; runtime: BrowserScheduleRuntime }>();
const drivenTimers = new Map<string, { periodMs: number; timer: ReturnType<typeof setInterval> }>();

function reportBrowserEffect(event: { type: string; causationId?: string; data: unknown }) {
  send({
    kind: event.type,
    url: "",
    title: event.causationId ?? "",
    text: JSON.stringify(event.data),
  });
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

if (chrome.webNavigation?.onCommitted) {
  chrome.webNavigation.onCommitted.addListener((d) => {
    if (/^https:\/\/(?:www\.)?claude\.ai\//.test(d.url)) {
      send({
        kind: "netcapture.navigation",
        url: d.url,
        title: "",
        text: JSON.stringify({ source: "webNavigation", tabId: d.tabId, frameId: d.frameId }),
      });
    }
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

// MAIN-world interception supplies response bodies. webRequest supplies a
// metadata fallback for usage requests issued by workers or another page
// context, where window.fetch/XHR cannot observe the request.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!/\/api\/organizations\/[^/]+\/usage(?:[?#]|$)/.test(details.url)) return undefined;
    send({
      kind: "netcapture.seen",
      url: details.url,
      title: "",
      text: JSON.stringify({
        method: details.method,
        source: "webRequest",
        tabId: details.tabId,
      }),
    });
    return undefined;
  },
  { urls: ["https://claude.ai/*", "https://*.claude.ai/*"] },
);

// Relayed messages: activity events carry {kind}; rule hits carry {cmd:"rulematch"}.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.cmd === "rulematch") {
    postRuleMatch(msg.ruleId, msg.url, msg.matches, msg.stream, msg.schema);
  } else if (msg.cmd === "automationEmission") {
    send({ type: "rulematch", ...msg.emission });
  } else if (msg.cmd === "expressionTrace") {
    send({
      kind: "rule.trace",
      url: msg.url,
      title: msg.ruleId,
      text: JSON.stringify({ ruleId: msg.ruleId, traces: msg.traces }),
    });
  } else if (msg.cmd === "netcaptureDiagnostic") {
    const details = JSON.stringify({
      method: msg.method,
      status: msg.status,
      rules: msg.rules,
      detail: msg.detail,
    });
    send({ kind: msg.kind, url: msg.url, title: "", text: details });
  } else if (typeof msg.kind === "string") {
    send(msg);
  }
});

function postRuleMatch(ruleId: string, url: string, matches: MatchFields[], stream?: string, schema?: JsonSchema) {
  const ev: RuleMatchEvent = {
    type: "rulematch",
    ruleId,
    url,
    ts: Date.now(),
    matches: matches || [],
    ...(stream ? { stream } : {}),
    ...(schema ? { schema } : {}),
  };
  send(ev);
}

// ---------------------------------------------------------------------------
// 2. Config transport — the server is the source of truth for rules.
// ---------------------------------------------------------------------------
async function refreshConfig(): Promise<Rule[]> {
  try {
    const cfg = await executeHttp(paths.activityConfig.endpoint, undefined);
    const rules = Array.isArray(cfg.rules) ? cfg.rules as unknown as Rule[] : [];
    await chrome.storage.local.set({ rules, rulesRevision: cfg.revision ?? 0 });
    await executeHttp(paths.activityHeartbeat.endpoint, {
      revision: cfg.revision ?? 0,
      rulesCount: rules.length,
    }).catch(() => {});
    await armDrivenAlarms(rules);
    return rules;
  } catch {
    /* server down -> keep the cached rules */
  }
  const { rules } = await chrome.storage.local.get("rules");
  const cached = Array.isArray(rules) ? (rules as Rule[]) : [];
  await armDrivenAlarms(cached);
  return cached;
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

void setup();

// ---------------------------------------------------------------------------
// 3. Driven scans — reload a dedicated bg tab per rule and scrape it.
// ---------------------------------------------------------------------------
function drivenRules(rules: Rule[]): Rule[] {
  return rules.filter((rule) => rule.enabled !== false && schedulePeriodMs(rule.schedule) != null);
}

function syncScheduleRuntimes(rules: Rule[]) {
  const effectRules = new Map(drivenRules(rules).flatMap((rule) => {
    if (typeof rule.schedule !== "object") return [];
    const hasEffects = isIntervalPipeSchedule(rule.schedule) || (rule.schedule.effects?.length ?? 0) > 0;
    return hasEffects ? [[rule.id, rule] as const] : [];
  }));
  for (const [ruleId, current] of browserSchedules) {
    const rule = effectRules.get(ruleId);
    const signature = rule ? JSON.stringify(rule.schedule) : "";
    if (!rule || signature !== current.signature) {
      current.runtime.close();
      browserSchedules.delete(ruleId);
    }
  }
  for (const [ruleId, rule] of effectRules) {
    if (browserSchedules.has(ruleId) || typeof rule.schedule !== "object") continue;
    browserSchedules.set(ruleId, {
      signature: JSON.stringify(rule.schedule),
      runtime: createBrowserScheduleRuntime(rule.schedule, reportBrowserEffect),
    });
  }
}

async function armDrivenAlarms(rules: Rule[]) {
  syncScheduleRuntimes(rules);
  const scheduled = drivenRules(rules);
  const shortPeriods = new Map(scheduled.flatMap((rule) => {
    const periodMs = schedulePeriodMs(rule.schedule);
    return periodMs != null && periodMs < MIN_ALARM_MS ? [[rule.id, periodMs] as const] : [];
  }));
  for (const [ruleId, current] of drivenTimers) {
    if (shortPeriods.get(ruleId) !== current.periodMs) {
      clearInterval(current.timer);
      drivenTimers.delete(ruleId);
    }
  }
  for (const [ruleId, periodMs] of shortPeriods) {
    if (drivenTimers.has(ruleId)) continue;
    drivenTimers.set(ruleId, {
      periodMs,
      timer: setInterval(() => void runDriven(ruleId), periodMs),
    });
  }
  const want = new Map(scheduled.flatMap((rule) => {
    const periodMs = schedulePeriodMs(rule.schedule);
    return periodMs != null && periodMs >= MIN_ALARM_MS ? [[DRIVEN_PREFIX + rule.id, rule] as const] : [];
  }));
  const existing = await chrome.alarms.getAll();
  const existingByName = new Map(existing.map((alarm) => [alarm.name, alarm]));
  for (const al of existing) {
    if (al.name.startsWith(DRIVEN_PREFIX) && !want.has(al.name)) chrome.alarms.clear(al.name);
  }
  for (const [name, rule] of want) {
    const period = Math.max(0.5, (schedulePeriodMs(rule.schedule) ?? 60_000) / 60_000);
    if (existingByName.get(name)?.periodInMinutes !== period) {
      chrome.alarms.create(name, { periodInMinutes: period });
    }
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
  if (!rule || typeof rule.schedule !== "object") return;
  const browserSchedule = browserSchedules.get(rule.id);
  if (browserSchedule) {
    browserSchedule.runtime.dispatch(rule.id);
    return;
  }
  if (!rule.url) return;
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
