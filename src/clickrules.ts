// ⌘-click action table (our "internal routing"): a ⌘-click on a terminal token
// (or free text inside a preview / rg panel) runs the first clickRules rule whose
// regex matches it. The token is shell-quoted into `$1`, the command runs in the
// pane cwd via run_click, and any stdout opens a results panel on the right.
import { invoke } from "./generated/native";
import { store, DEFAULT_CLICK_RULES, type ClickRule } from "./state";
import { addPreviewPanel } from "./reactdock";
import { escapeHtml, shQuote, MD_EXTS } from "./core";
import { openPreviewPanel, previewOrigin } from "./preview";
import { openMarkdownPanel } from "./mdview/open";
import { getFocusedTermId, tabMetaById } from "./terminal";

const clickRules = (): ClickRule[] => store.get().clickRules ?? DEFAULT_CLICK_RULES;

export function clickRuleFor(rawToken: string): ClickRule | null {
  const token = rawToken.trim();
  return clickRules().find((r) => {
    try { return new RegExp(r.pattern).test(token); } catch { return false; }
  }) ?? null;
}

export function clickIntent(rawToken: string, cwd: string): string {
  const token = rawToken.trim();
  if (/^(?:https?:\/\/|www\.)/i.test(token)) return "open URL";
  if (/^(?:\/|~\/|\.\.?\/)/.test(token) || (cwd && /\//.test(token))) return "open/preview file";
  return clickRuleFor(token) ? "run configured action from terminal cwd" : "search from terminal cwd";
}

export function resolveReference(rawToken: string, cwd: string): { path: string; line?: number } | null {
  const token = rawToken.trim().replace(/^['"`]|['"`]$/g, "");
  if (!token || /^(?:https?:\/\/|www\.)/i.test(token)) return null;
  const match = token.match(/^(.*?):(\d+)(?::\d+)?$/);
  const bare = match?.[1] ?? token;
  const line = match ? Number(match[2]) : undefined;
  const fileish = /^\/?(?:~\/|\.\.?\/|[^\s:]+\/)/.test(bare) || /\.[A-Za-z0-9]{1,16}$/.test(bare);
  if (!fileish) return null;
  if (bare.startsWith("/") || bare.startsWith("~/")) return { path: bare, line };
  return { path: cwd ? `${cwd.replace(/\/$/, "")}/${bare}` : bare, line };
}

export async function dispatchClick(rawToken: string, cwd: string) {
  const token = rawToken.trim();
  if (!token) return;
  // Markdown paths route to the mdview panel instead of the shell rule — the
  // default catch-all would otherwise `code -g` them (shelling out to the OS
  // editor is exactly what the viewer replaces).
  const ref = resolveReference(token, cwd);
  if (ref) {
    const name = ref.path.split("/").pop() ?? ref.path;
    const ext = (name.includes(".") ? name.split(".").pop()! : "").toLowerCase();
    if (MD_EXTS.has(ext)) {
      if (ref.line) openPreviewPanel(ref.path, ref.line);
      else openMarkdownPanel(ref.path);
      return;
    }
  }
  const rule = clickRuleFor(token);
  if (!rule) return;
  const command = rule.command.replace(/\$1/g, () => shQuote(token));
  let out = "";
  try {
    out = await invoke<string>("run_click", { command, cwd });
  } catch (e) {
    out = String(e);
  }
  if (out.trim()) openClickPanel(token, out, cwd, rule);
}

// cwd to search from when a ⌘-click happens outside a terminal: the focused
// terminal tab's cwd (best proxy for "where am I"), else empty (run_click falls
// back to HOME).
const activeCwd = (): string => {
  const id = getFocusedTermId();
  return id ? tabMetaById(id)?.cwd ?? "" : "";
};

// The word under a viewport point in DOM text (preview / rg panels). Mirrors the
// terminal's wordAt: expands to whitespace, trimming the wrapping punctuation the
// clickRules grep would choke on otherwise.
function domWordAt(x: number, y: number): string {
  const range = document.caretRangeFromPoint?.(x, y);
  const node = range?.startContainer;
  if (!range || !node || node.nodeType !== Node.TEXT_NODE) return "";
  const text = node.nodeValue ?? "";
  const quoted = quotedSpanAt(text, range.startOffset);
  if (quoted) return quoted;
  const isWord = (c: string | undefined) => !!c && /\S/.test(c) && !/['"<>(){}\[\],;:]/.test(c);
  let a = range.startOffset;
  let b = range.startOffset;
  while (a > 0 && isWord(text[a - 1])) a--;
  while (b < text.length && isWord(text[b])) b++;
  return text.slice(a, b).trim();
}

// ⌘-click on free text inside a preview / rg panel runs the same clickRules
// search as the terminal. Capture phase, so it beats the panels' own click
// handlers; interactive bits (back, config link, hit rows, buttons) are skipped
// so their own actions still fire on ⌘-click.
export function wireDomCmdClick() {
  document.addEventListener(
    "mousedown",
    (e) => {
      if (!e.metaKey || e.button !== 0) return;
      const t = e.target as HTMLElement;
      if (t.closest(".term-host") || t.closest(".xterm")) return; // terminals self-handle
      if (!t.closest(".fs-preview, .rg-panel")) return;
      if (t.closest(".fs-back, .rg-cfg, .rg-file, .rg-hit, a, button")) return;
      const sel = window.getSelection()?.toString().trim() ?? "";
      const word = sel || domWordAt(e.clientX, e.clientY);
      if (!word) return;
      e.preventDefault();
      e.stopPropagation();
      void dispatchClick(word, activeCwd());
    },
    { capture: true },
  );
}

const clickPanelEls = new Map<string, HTMLElement>();

// Adopt a per-query results node into a right-side panel (same plumbing as file
// previews). Re-running the same query refreshes the existing panel.
function openClickPanel(query: string, output: string, cwd: string, rule: ClickRule) {
  const key = `rg:${query}`;
  let el = clickPanelEls.get(key);
  if (!el) {
    el = document.createElement("div");
    el.className = "rg-panel";
    clickPanelEls.set(key, el);
  }
  renderClickOutput(el, query, output, cwd, rule);
  addPreviewPanel(key, query, el, "right");
}

// Render command stdout grouped like ripgrep's heading view: one file header per
// path, then its `line  text` hits. Lines shaped `path:line:text` (rg -n piped)
// parse into hits that open the file preview at that line; anything else falls
// back to a plain row.
type RgHit = { line: number; text: string };
type RgGroup = { path: string; hits: RgHit[] };

function renderClickOutput(el: HTMLElement, query: string, output: string, cwd: string, rule: ClickRule) {
  const base = cwd.replace(/\/$/, "");
  const resolve = (p: string) => (p.startsWith("/") || p.startsWith("~") ? p : base ? `${base}/${p}` : p);
  const lines = output.replace(/\n+$/, "").split("\n");

  const groups: RgGroup[] = [];
  const plain: string[] = [];
  for (const l of lines) {
    const m = l.match(/^(.+?):(\d+):(.*)$/);
    if (!m) {
      if (l) plain.push(l);
      continue;
    }
    const [, p, ln, rest] = m;
    const g = groups[groups.length - 1];
    if (g && g.path === p) g.hits.push({ line: +ln, text: rest });
    else groups.push({ path: p, hits: [{ line: +ln, text: rest }] });
  }

  const hitCount = groups.reduce((n, g) => n + g.hits.length, 0);
  const fileRow = (p: string) =>
    `<div class="rg-file" data-path="${escapeHtml(p)}">${escapeHtml(p)}</div>`;
  const hitRow = (p: string, h: RgHit) =>
    `<div class="rg-hit" data-path="${escapeHtml(p)}" data-line="${h.line}">` +
    `<span class="rg-ln">${h.line}</span><span class="rg-tx">${escapeHtml(h.text) || " "}</span></div>`;

  const body =
    groups
      .map((g) => `<div class="rg-group">${fileRow(g.path)}${g.hits.map((h) => hitRow(g.path, h)).join("")}</div>`)
      .join("") + plain.map((l) => `<div class="rg-plain">${escapeHtml(l)}</div>`).join("");

  el.innerHTML =
    `<div class="rg-head">${escapeHtml(query)}` +
    (hitCount
      ? ` <span class="rg-count">${hitCount} match${hitCount === 1 ? "" : "es"} · ${groups.length} file${groups.length === 1 ? "" : "s"}</span>`
      : "") +
    `</div>` +
    `<div class="rg-sub">ran <code>${escapeHtml(rule.command)}</code> · ` +
    `<a class="rg-cfg" href="#">config</a></div>` +
    `<div class="rg-body">${body || '<div class="rg-plain">no matches</div>'}</div>`;

  el.querySelector<HTMLElement>(".rg-cfg")?.addEventListener("click", (e) => {
    e.preventDefault();
    openClickConfigPanel();
  });
  el.querySelectorAll<HTMLElement>(".rg-body [data-path]").forEach((node) =>
    node.addEventListener("click", () => {
      const p = node.getAttribute("data-path") ?? "";
      const ln = Number(node.getAttribute("data-line") ?? "0");
      if (!p) return;
      const full = resolve(p);
      previewOrigin.set(full, `rg:${query}`); // record before render so "← back" shows
      openPreviewPanel(full, ln > 0 ? ln : undefined);
    }),
  );

  // Highlight the matched token. NB: no shiki syntax-coloring on hit rows — it
  // splits a row into per-token spans, so a multi-token / punctuated query (e.g.
  // "markTokenInNode(root") spans several text nodes and the per-node search finds
  // nothing. Plain text keeps each row as one text node, so the match (punctuation
  // and all) is always found and wrapped.
  markClickMatches(el, query);
}

// Wrap each occurrence of the searched token inside the hit rows with a
// translucent highlighter, superscripted with its 1-based global index — so the
// "N matches" count is visible at a glance (you can find all N, not just the
// files). Operates on text nodes, so it works whether or not shiki colored the
// row, and a match nested inside a colored span is still wrapped.
function markClickMatches(el: HTMLElement, query: string) {
  const q = query.trim();
  if (!q) return;
  const txs = Array.from(el.querySelectorAll<HTMLElement>(".rg-tx"));
  if (txs.length === 0 || txs.length > 1000) return; // keep huge result sets snappy
  const lc = q.toLowerCase();
  let idx = 0;
  for (const tx of txs) {
    // Unwrap any prior marks first so re-runs (e.g. after shiki recolors a row)
    // re-index cleanly instead of nesting <mark> inside <mark>. The match text is
    // the mark's first child; the <sup> badge is dropped.
    tx.querySelectorAll<HTMLElement>(".rg-mark").forEach((m) => {
      m.replaceWith(document.createTextNode(m.childNodes[0]?.nodeValue ?? ""));
    });
    tx.normalize();
    idx = markTokenInNode(tx, lc, q.length, idx);
  }
}

function markTokenInNode(root: HTMLElement, lc: string, len: number, startIdx: number): number {
  let idx = startIdx;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) textNodes.push(n as Text);
  for (const tn of textNodes) {
    const text = tn.nodeValue ?? "";
    const hay = text.toLowerCase();
    if (!hay.includes(lc)) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (let pos = hay.indexOf(lc); pos >= 0; pos = hay.indexOf(lc, last)) {
      if (pos > last) frag.appendChild(document.createTextNode(text.slice(last, pos)));
      const mark = document.createElement("mark");
      mark.className = "rg-mark";
      mark.textContent = text.slice(pos, pos + len);
      idx += 1;
      const badge = document.createElement("span");
      badge.className = "rg-idx";
      badge.textContent = String(idx);
      mark.appendChild(badge);
      frag.appendChild(mark);
      last = pos + len;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    tn.parentNode?.replaceChild(frag, tn);
  }
  return idx;
}

// The ⌘-click action table, editable in-app. This is our "internal routing": the
// `config` link in a results panel calls straight into this — no URL scheme, just
// open the editor panel. Edits persist to the store (and thus localStorage).
function openClickConfigPanel() {
  const key = "config:clickRules";
  let el = clickPanelEls.get(key);
  if (!el) {
    el = document.createElement("div");
    el.className = "rg-panel";
    clickPanelEls.set(key, el);
  }
  renderClickConfig(el);
  addPreviewPanel(key, "click rules", el, "right");
}

function renderClickConfig(el: HTMLElement) {
  const rules = store.get().clickRules ?? DEFAULT_CLICK_RULES;
  el.innerHTML =
    `<div class="rg-head">click rules <span class="rg-count">⌘-click actions</span></div>` +
    `<div class="rg-body rg-cfg-body">` +
    `<div class="rg-cfg-help">First rule whose <b>pattern</b> (JS regex) matches the clicked token wins; ` +
    `<code>$1</code> is the token (shell-quoted) substituted into <b>command</b>. Any stdout opens a results panel.</div>` +
    `<textarea class="rg-cfg-ta" spellcheck="false"></textarea>` +
    `<div class="rg-cfg-row"><button class="rg-cfg-save">save</button>` +
    `<button class="rg-cfg-reset">reset</button><span class="rg-cfg-msg"></span></div>` +
    `</div>`;
  const ta = el.querySelector<HTMLTextAreaElement>(".rg-cfg-ta")!;
  const msg = el.querySelector<HTMLElement>(".rg-cfg-msg")!;
  ta.value = JSON.stringify(rules, null, 2);
  el.querySelector<HTMLElement>(".rg-cfg-save")?.addEventListener("click", () => {
    try {
      const parsed = JSON.parse(ta.value) as ClickRule[];
      if (!Array.isArray(parsed) || !parsed.every((r) => typeof r?.pattern === "string" && typeof r?.command === "string"))
        throw new Error("expected [{pattern, command}, …]");
      store.set({ clickRules: parsed });
      msg.textContent = "saved";
    } catch (e) {
      msg.textContent = String(e);
    }
  });
  el.querySelector<HTMLElement>(".rg-cfg-reset")?.addEventListener("click", () => {
    store.set({ clickRules: DEFAULT_CLICK_RULES });
    ta.value = JSON.stringify(DEFAULT_CLICK_RULES, null, 2);
    msg.textContent = "reset";
  });
}

// If `col` (0-based) sits inside a '…' / "…" / `…` span, return the unquoted
// contents — spaces and all — so ⌘-click treats a quoted path (e.g. a screenshot
// path with spaces) as one token instead of splitting on whitespace.
export function quotedSpanAt(text: string, col: number): string | null {
  for (const q of ["'", '"', "`"]) {
    let from = 0;
    for (;;) {
      const open = text.indexOf(q, from);
      if (open < 0) break;
      const close = text.indexOf(q, open + 1);
      if (close < 0) break;
      if (col > open && col < close) return text.slice(open + 1, close);
      from = close + 1;
    }
  }
  return null;
}
