import type { Effect } from "../../src/lib/json-rx/0_types";

// Shared types for the config-driven MV3 core. The server (instant) is the
// source of truth for rules; the extension caches them in chrome.storage.local
// and re-fetches each alarm tick. Everything here is plain data — no chrome.*
// refs — so it bundles into every world (background, isolated, MAIN).

// How a rule extracts data from a matched page.
//   textnodes: TreeWalker over text nodes, `regex` with capture groups.
//   selector : querySelectorAll(selector), `regex` applied per node's text.
//   netcapture: MAIN-world fetch/XHR responses whose URL matches `url`|`regex`.
export type RuleMode = "textnodes" | "selector" | "netcapture";

export type RuleEffect = Effect;

// "passive" (or absent) = only react to live pages the user visits.
// An interval with no effects preserves the legacy dedicated-tab scan.
// Effects are interpreted by extension plugins; the rule model stays generic.
export type Schedule = { intervalMin: number; effects?: RuleEffect[] } | "passive";

export type DiagnosticsMode = "off" | "errors" | "all";

export type ExpressionTrace = {
  ruleId: string;
  phase: "extract" | "guard" | "filter";
  path: string;
  language: "jsonata" | "json-logic";
  expression: string | unknown;
  outcome: "passed" | "filtered" | "missing" | "error";
  result?: unknown;
  reason?: string;
};

export interface Rule {
  id: string;
  host: string; // regex, tested against location.host
  url?: string; // regex, tested against location.href (or a netcapture URL)
  mode: RuleMode;
  selector?: string; // selector mode: the node set to scan
  regex?: string; // capture regex; groups feed `captures`
  // Map a regex capture (group name or 1-based index as a string) to a field
  // name in the reported match. Empty = report the whole match under "match".
  captures?: Record<string, string>;
  request?: {
    methods?: string[];
    url?: string;
  };
  response?: {
    extract?: Record<string, string>;
  };
  diagnostics?: DiagnosticsMode;
  emit?: {
    stream: string;
    schema?: JsonSchema;
  };
  schedule?: Schedule;
  enabled?: boolean; // default true; the control-center toggle writes this
}

export interface JsonSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  format?: string;
}

// GET /config response. `rules` is authoritative; the extension replaces its
// cache with whatever the server returns.
export interface ServerConfig {
  revision?: number;
  rules: Rule[];
}

// One extracted record: capture field -> value.
export type MatchFields = Record<string, unknown>;

// POST /ingest body for a rule hit (new event type, alongside the activity spy's
// {kind,url,title,text} events which stay unchanged).
export interface RuleMatchEvent {
  type: "rulematch";
  ruleId: string;
  url: string;
  ts: number; // unix ms
  matches: MatchFields[];
  stream?: string;
  schema?: JsonSchema;
}

// Activity-spy event (unchanged shape the server already accepts).
export interface ActivityEvent {
  kind: string;
  url: string;
  title: string;
  text: string;
}

// Isolated <-> MAIN world bridge message (netcapture). The MAIN patch posts
// intercepted JSON responses; the isolated relay matches them against rules.
export interface NetCaptureMessage {
  source: "ext-netcapture";
  type?: "seen" | "response" | "error";
  url: string;
  method: string;
  ts: number;
  status?: number;
  detail?: string;
  body?: unknown;
}
