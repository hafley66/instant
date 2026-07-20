// Shared types for the config-driven MV3 core. The server (instant) is the
// source of truth for rules; the extension caches them in chrome.storage.local
// and re-fetches each alarm tick. Everything here is plain data — no chrome.*
// refs — so it bundles into every world (background, isolated, MAIN).

// How a rule extracts data from a matched page.
//   textnodes: TreeWalker over text nodes, `regex` with capture groups.
//   selector : querySelectorAll(selector), `regex` applied per node's text.
//   netcapture: MAIN-world fetch/XHR responses whose URL matches `url`|`regex`.
export type RuleMode = "textnodes" | "selector" | "netcapture";

// "passive" (or absent) = only react to live pages the user visits.
// {intervalMin} = driven: an alarm reloads a background tab and scans it.
export type Schedule = { intervalMin: number } | "passive";

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
  url: string;
  method: string;
  ts: number;
  body: unknown;
}
