// DOM scanners for the passive (live-page) path. Both return the extracted
// records for one rule; the caller dedupes and reports. Generalizes local-ext's
// TreeWalker scan (background.js:376-408) from usage-specific to regex-driven.
import type { MatchFields, Rule } from "./0_types";
import { compile, mapCaptures } from "./1_match";

// Run a rule's regex over one string, collecting every match as a record. The
// regex is forced global so a single node with repeats yields multiple records.
function extract(rule: Rule, text: string): MatchFields[] {
  const re = compile(rule.regex, globalFlags(rule.regex));
  if (!re) return [];
  const out: MatchFields[] = [];
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(text))) {
    out.push(mapCaptures(rule, m));
    if (m.index === re.lastIndex) re.lastIndex++; // guard zero-width matches
  }
  return out;
}

function globalFlags(pattern: string | undefined): string {
  return pattern && pattern.includes("(?i)") ? "gi" : "g";
}

// textnodes: walk every text node under <body>, run the regex on each.
export function scanTextNodes(rule: Rule, root: ParentNode = document.body): MatchFields[] {
  if (!root) return [];
  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT);
  const out: MatchFields[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = (node.nodeValue || "").trim();
    if (text) out.push(...extract(rule, text));
  }
  return out;
}

// selector: run the regex over each matched element's textContent. No regex ->
// report the element's trimmed text under "match".
export function scanSelector(rule: Rule, root: ParentNode = document): MatchFields[] {
  if (!rule.selector) return [];
  let nodes: NodeListOf<Element>;
  try {
    nodes = root.querySelectorAll(rule.selector);
  } catch {
    return []; // invalid selector — treat as no match
  }
  const out: MatchFields[] = [];
  for (const el of nodes) {
    const text = (el.textContent || "").trim();
    if (!text) continue;
    if (rule.regex) out.push(...extract(rule, text));
    else out.push({ match: text });
  }
  return out;
}

// Dispatch by mode (netcapture is handled out-of-band by the MAIN patch).
export function scanRule(rule: Rule): MatchFields[] {
  if (rule.mode === "textnodes") return scanTextNodes(rule);
  if (rule.mode === "selector") return scanSelector(rule);
  return [];
}
