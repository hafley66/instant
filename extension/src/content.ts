// Isolated-world content script on <all_urls>. Two jobs:
//   1. Activity spy (unchanged behavior): relay copies/selections/DOM
//      interactions to the background worker, which owns the localhost POST.
//   2. Rule engine: if any enabled rule's host regex matches this page, run its
//      passive scan (textnodes/selector), re-scan on DOM mutations, publish
//      netcapture patterns for the MAIN patch, and relay netcapture hits.
// It no-ops the rule engine entirely on hosts no rule matches, so the cost on an
// unrelated page is one storage read.
import type { ExpressionTrace, MatchFields, NetCaptureMessage, Rule } from "./0_types";
import type { DashboardEmission, NetworkResponse } from "@hafley66/json-rx";
import { compile, mapCaptures, ruleMatchesLocation, rulesForHost } from "./1_match";
import { scanRule } from "./2_scan";
import { extractResponseDetailed } from "./3_extract";
import { createV2RuleRuntime, type V2RuleRuntime } from "./6_v2Rules";

const MAX = 4000;

// ---------------------------------------------------------------------------
// 1. Activity spy — verbatim from the original content.js, typed.
// ---------------------------------------------------------------------------
function relay(kind: string, text: string) {
  const t = (text || "").trim();
  if (!t) return;
  chrome.runtime
    .sendMessage({ kind, url: location.href, title: document.title, text: t.slice(0, MAX) })
    .catch(() => {});
}

document.addEventListener("copy", () => relay("clipboard", String(window.getSelection())));

let selTimer: ReturnType<typeof setTimeout> | undefined;
document.addEventListener("selectionchange", () => {
  clearTimeout(selTimer);
  selTimer = setTimeout(() => {
    const s = String(window.getSelection());
    if (s.trim().length > 8) relay("selection", s);
  }, 700);
});

function describe(el: Element | null): string {
  if (!el || el.nodeType !== 1) return "";
  const id = el.id ? `#${el.id}` : "";
  const cls =
    el.className && typeof el.className === "string"
      ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
      : "";
  return `${el.tagName.toLowerCase()}${id}${cls}`;
}
function mods(e: MouseEvent): string {
  const m: string[] = [];
  if (e.ctrlKey) m.push("ctrl");
  if (e.metaKey) m.push("cmd");
  if (e.shiftKey) m.push("shift");
  if (e.altKey) m.push("alt");
  return m.length ? ` [${m.join("+")}]` : "";
}
function context(e: MouseEvent): string {
  const el = e.target as (Element & { value?: string; alt?: string }) | null;
  const sel = describe(el);
  const label = ((el as HTMLElement)?.innerText || el?.value || el?.alt || "").trim().slice(0, 80);
  const link = el?.closest?.("a[href]") as HTMLAnchorElement | null;
  const href = link ? ` ${link.href}` : "";
  return `${sel}${label ? ` "${label}"` : ""}${href}${mods(e)}`;
}

const last: Record<string, number> = {};
function throttled(kind: string, ms: number): boolean {
  const now = Date.now();
  if (last[kind] && now - last[kind] < ms) return false;
  last[kind] = now;
  return true;
}

document.addEventListener(
  "click",
  (e) => {
    const kind = e.ctrlKey || e.metaKey ? "ctrlclick" : "click";
    if (throttled(kind, 300)) relay(kind, context(e));
  },
  true,
);
document.addEventListener("dblclick", (e) => throttled("dblclick", 300) && relay("dblclick", context(e)), true);
document.addEventListener("dragstart", (e) => throttled("drag", 300) && relay("drag", context(e as MouseEvent)), true);
document.addEventListener("contextmenu", (e) => throttled("rclick", 300) && relay("rclick", context(e)), true);

// ---------------------------------------------------------------------------
// 2. Rule engine.
// ---------------------------------------------------------------------------
const NET_ATTR = "data-ext-netcapture";
let active: Rule[] = []; // rules whose host matches this page
// Per-rule set of already-reported match signatures, so a MutationObserver
// re-scan (or a repeated fetch) doesn't re-post identical records.
const seen = new Map<string, Set<string>>();
let v2Runtimes = new Map<string, V2RuleRuntime>();

function sig(fields: MatchFields): string {
  const keys = Object.keys(fields).sort();
  return keys.map((k) => `${k}=${fields[k]}`).join("");
}

function freshMatches(rule: Rule, matches: MatchFields[]): MatchFields[] {
  if (!matches.length) return [];
  let dedup = seen.get(rule.id);
  if (!dedup) seen.set(rule.id, (dedup = new Set()));
  const fresh = matches.filter((m) => {
    const s = sig(m);
    if (dedup!.has(s)) return false;
    dedup!.add(s);
    return true;
  });
  return fresh;
}

function reportMatches(rule: Rule, matches: MatchFields[]) {
  const fresh = freshMatches(rule, matches);
  if (!fresh?.length) return;
  chrome.runtime
    .sendMessage({
      cmd: "rulematch",
      ruleId: rule.id,
      url: location.href,
      matches: fresh,
      stream: rule.emit?.stream,
      schema: rule.emit?.schema,
    })
    .catch(() => {});
}

function reportEmission(rule: Rule, emission: DashboardEmission) {
  const fresh = freshMatches(rule, emission.matches.filter((match) => Object.keys(match).length > 0));
  if (!fresh?.length) return;
  chrome.runtime.sendMessage({
    cmd: "automationEmission",
    emission: { ...emission, matches: fresh, automationVersion: "automation.v2" },
  }).catch(() => {});
}

function reportTraces(rule: Rule, traces: ExpressionTrace[]) {
  chrome.runtime.sendMessage({
    cmd: "expressionTrace",
    ruleId: rule.id,
    url: location.href,
    traces,
  }).catch(() => {});
}

// Publish the netcapture URL patterns so the MAIN patch knows what to intercept.
function publishNetPatterns() {
  const pats = active
    .filter((r) => r.mode === "netcapture")
    .map((r) => ({
      url: r.request?.url || r.url || r.regex,
      methods: r.request?.methods?.map((m) => m.toUpperCase()),
    }))
    .filter((p) => !!p.url);
  if (pats.length) document.documentElement.setAttribute(NET_ATTR, JSON.stringify(pats));
  else document.documentElement.removeAttribute(NET_ATTR);
}

function netRuleMatches(rule: Rule, method: string, url: string): boolean {
  const urlPattern = rule.request?.url || rule.url || rule.regex;
  const urlRe = compile(urlPattern);
  if (urlRe && !urlRe.test(url)) return false;
  const methods = rule.request?.methods;
  return !methods?.length || methods.some((m) => m.toUpperCase() === method.toUpperCase());
}

function runPassiveScans() {
  for (const rule of active) {
    if (rule.mode === "netcapture") continue;
    if (!ruleMatchesLocation(rule, location.host, location.href)) continue;
    reportMatches(rule, scanRule(rule));
  }
}

// Debounced re-scan for SPAs: the initial document_idle scan misses content that
// hydrates later or on route change.
let scanTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleScan() {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(runPassiveScans, 400);
}

function startEngine(rules: Rule[]) {
  for (const runtime of v2Runtimes.values()) runtime.close();
  v2Runtimes = new Map();
  active = rulesForHost(rules, location.host);
  chrome.runtime.sendMessage({
    cmd: "netcaptureDiagnostic",
    kind: "netcapture.ready",
    url: location.href,
    rules: active.filter((rule) => rule.mode === "netcapture").map((rule) => rule.id),
  }).catch(() => {});
  if (!active.length) {
    document.documentElement.removeAttribute(NET_ATTR);
    return;
  }
  publishNetPatterns();
  for (const rule of active) {
    if (rule.mode === "netcapture" && rule.response?.extract && rule.emit) {
      v2Runtimes.set(rule.id, createV2RuleRuntime(rule, {
        emission: reportEmission,
        traces: reportTraces,
      }));
    }
  }
  if (active.some((r) => r.mode !== "netcapture")) {
    runPassiveScans();
    if (document.body) {
      new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true, characterData: true });
    }
  }
}

// netcapture relay: MAIN patch posts intercepted JSON here (isolated world).
// Match the URL against each netcapture rule and, if the rule has a regex, run
// it over the JSON stringified body; else report the whole URL as one hit.
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const d = event.data as NetCaptureMessage | undefined;
  if (!d || d.source !== "ext-netcapture") return;
  if (d.type === "seen" || d.type === "error") {
    const rules = active
      .filter((rule) => rule.mode === "netcapture" && netRuleMatches(rule, d.method, d.url))
      .map((rule) => rule.id);
    chrome.runtime.sendMessage({
      cmd: "netcaptureDiagnostic",
      kind: d.type === "seen" ? "netcapture.seen" : "netcapture.error",
      url: d.url,
      method: d.method,
      status: d.status,
      detail: d.detail,
      rules,
    }).catch(() => {});
    return;
  }
  if (d.type && d.type !== "response") return;
  if (!d.body) return;
  for (const rule of active) {
    if (rule.mode !== "netcapture") continue;
    if (!netRuleMatches(rule, d.method, d.url)) continue;
    const v2Runtime = v2Runtimes.get(rule.id);
    if (v2Runtime) {
      v2Runtime.next({
        method: d.method,
        pageUrl: location.href,
        requestUrl: d.url,
        status: d.status ?? 0,
        ts: d.ts,
        body: d.body as NetworkResponse["body"],
      });
    } else if (rule.response?.extract) {
      void extractResponseDetailed(rule, d.body).then(({ matches, traces }) => {
        if (traces.length) {
          chrome.runtime.sendMessage({
            cmd: "expressionTrace",
            ruleId: rule.id,
            url: d.url,
            traces,
          }).catch(() => {});
        }
        reportMatches(rule, matches);
      });
    } else if (rule.regex) {
      const re = compile(rule.regex, "g");
      if (!re) continue;
      const text = typeof d.body === "string" ? d.body : JSON.stringify(d.body);
      const out: MatchFields[] = [];
      let m: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((m = re.exec(text))) {
        out.push(mapCaptures(rule, m));
        if (m.index === re.lastIndex) re.lastIndex++;
      }
      reportMatches(rule, out);
    } else {
      reportMatches(rule, [{ url: d.url }]);
    }
  }
});

// Rules come from chrome.storage.local, kept fresh by the background worker's
// config fetch. Re-evaluate on change (config edited in the control center).
async function loadRules(): Promise<Rule[]> {
  try {
    const { rules } = await chrome.storage.local.get("rules");
    return Array.isArray(rules) ? (rules as Rule[]) : [];
  } catch {
    return [];
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.rules) {
    seen.clear();
    startEngine((changes.rules.newValue as Rule[]) || []);
  }
});

// Driven scan: the background worker reloaded this (background) tab on a rule's
// schedule and now asks for a fresh scan. Bypass the passive dedup so a poll
// always returns the current value; background posts the result.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.cmd !== "drivenScan") return;
  loadRules().then((rules) => {
    const rule = rules.find((r) => r.id === msg.ruleId);
    sendResponse(rule && rule.mode !== "netcapture" ? scanRule(rule) : []);
  });
  return true; // async sendResponse
});

loadRules().then(startEngine);
