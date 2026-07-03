// Pure matching helpers. A rule fires on a page when its `host` regex matches
// location.host and (if present) its `url` regex matches location.href.
import type { MatchFields, Rule } from "./0_types";

// Compile-cache: rule regexes are stable across a page's lifetime and re-scanned
// on every mutation, so caching by pattern string avoids re-parsing per scan.
const reCache = new Map<string, RegExp | null>();

// A bad pattern must not throw mid-scan; a null cache entry means "never match".
export function compile(pattern: string | undefined, flags = ""): RegExp | null {
  if (!pattern) return null;
  const key = flags + " " + pattern;
  if (reCache.has(key)) return reCache.get(key)!;
  let re: RegExp | null = null;
  try {
    re = new RegExp(pattern, flags);
  } catch {
    re = null;
  }
  reCache.set(key, re);
  return re;
}

export function ruleEnabled(r: Rule): boolean {
  return r.enabled !== false;
}

// Does this rule apply to the current location? host is required; url optional.
export function ruleMatchesLocation(r: Rule, host: string, href: string): boolean {
  const h = compile(r.host);
  if (!h || !h.test(host)) return false;
  if (r.url) {
    const u = compile(r.url);
    if (!u || !u.test(href)) return false;
  }
  return true;
}

// Rules active on this host, respecting enable flags. Cheap host-only gate the
// content script runs once before deciding whether to do any work at all.
export function rulesForHost(rules: Rule[], host: string): Rule[] {
  return rules.filter((r) => {
    if (!ruleEnabled(r)) return false;
    const h = compile(r.host);
    return !!h && h.test(host);
  });
}

// Turn one regex execution into a reported record using the rule's `captures`
// map. Keys are named groups or 1-based indices; value is the target field name.
// No captures -> report the whole match under "match".
export function mapCaptures(r: Rule, m: RegExpMatchArray): MatchFields {
  const out: MatchFields = {};
  const caps = r.captures;
  if (!caps || Object.keys(caps).length === 0) {
    out.match = m[0];
    return out;
  }
  for (const [group, field] of Object.entries(caps)) {
    let v: string | undefined;
    if (m.groups && group in m.groups) v = m.groups[group];
    else {
      const idx = Number(group);
      if (Number.isInteger(idx)) v = m[idx];
    }
    if (v != null) out[field] = v;
  }
  return out;
}
