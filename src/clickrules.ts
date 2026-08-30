// ⌘-click action table (our "internal routing"): a ⌘-click on a terminal token
// (or free text inside a preview / rg panel) runs the first clickRules rule whose
// regex matches it. The token is shell-quoted into `$1`, the command runs in the
// pane cwd via run_click, and any stdout opens a results panel on the right.
import { clickRpc } from "./ipc/contract";
import { DEFAULT_CLICK_RULES, type ClickRule } from "./state";
import { addPreviewPanel } from "./reactdock";
import { escapeHtml, shQuote } from "./core";
import { openPathInInstant, openPreviewPanel, previewOrigin } from "./preview";
import { getFocusedTermId, tabMetaById } from "./terminal";
import { splitLineRef, tokenAtColumn } from "./termTokens";
import { looksLikePath, resolveRef } from "./refResolve";
import { CmdClickRouter, type CmdClickSource } from "./0_clickRouter";
import { settings } from "./0_settings";

const clickRules = (): ClickRule[] => settings.clickRules.$() ?? DEFAULT_CLICK_RULES;

export function clickRuleFor(rawToken: string): ClickRule | null {
  const token = rawToken.trim();
  return clickRules().find((r) => {
    try { return new RegExp(r.pattern).test(token); } catch { return false; }
  }) ?? null;
}

export function clickIntent(rawToken: string): string {
  const token = rawToken.trim();
  if (/^(?:https?:\/\/|www\.)/i.test(token)) return "open URL";
  if (looksLikePath(token)) return "open/preview file";
  return clickRuleFor(token) ? "run configured action from terminal cwd" : "search from terminal cwd";
}

// The immediate guess for a token: cwd-joined, no filesystem access. The hover
// card paints this while resolveRef (which does touch the filesystem, and finds
// repo-relative and bare filenames) settles.
export function resolveReference(rawToken: string, cwd: string): { path: string; line?: number } | null {
  const token = rawToken.trim().replace(/^['"`]|['"`]$/g, "");
  if (!token || !looksLikePath(token)) return null;
  const { path: bare, line } = splitLineRef(token);
  if (!bare) return null;
  if (bare.startsWith("/") || bare.startsWith("~/")) return { path: bare, line };
  return { path: cwd ? `${cwd.replace(/\/$/, "")}/${bare}` : bare, line };
}

export const cmdClickRouter = new CmdClickRouter();

cmdClickRouter.register({
  id: "file",
  async handle({ token, cwd }) {
  // A path-shaped token goes to the resolver, which checks the cwd, the repo
  // root, and finally a filename search: agent output prints repo-relative
  // paths and bare filenames that do not exist under the shell's directory.
  const result = await resolveRef(token, cwd);
  if (result.kind === "choices") {
    openRefChoices(token, result.paths, result.line, cwd, result.via);
    return true;
  }
  // A file we located opens in Instant: markdown in the mdview tab, everything
  // else in the preview tab (which scrolls to the line and live-reloads). The
  // click rules still own what is left: urls, and tokens that name no file.
  if (result.kind === "hit") {
    const { path, line } = result.ref;
    await openPathInInstant(path, line);
    return true;
  }
  // Git knows the path, the working tree does not: show the blob at the newest
  // revision that still holds it rather than sending the token to ripgrep.
  if (result.kind === "absent") {
    await openGitBlobPanel(token, result, cwd);
    return true;
  }
  return false;
  },
});

cmdClickRouter.register({
  id: "configured-rule",
  handle: ({ token, cwd }) => runClickRule(token, cwd),
});

// The rule half of the ladder: whatever the token is, run its configured command
// (the catch-all greps) and adopt the stdout into a results panel.
export async function runClickRule(token: string, cwd: string): Promise<boolean> {
  const rule = clickRuleFor(token);
  if (!rule) return false;
  const command = rule.command.replace(/\$1/g, () => shQuote(token));
  let out = "";
  try {
    out = await clickRpc.runClick({ command, cwd });
  } catch (e) {
    out = String(e);
  }
  // Silence is the one answer a ⌘-click must never give: an empty result still
  // opens the panel, naming the command that found nothing.
  openClickPanel(token, out.trim() || `no match, and no file named ${token} on disk or in git`, cwd, rule);
  return true;
}

// A path git holds and the checkout does not. The panel names the revision and
// shows the file, so a ⌘-click on an un-checked-out path answers something.
async function openGitBlobPanel(
  token: string,
  found: { repo: string; rev: string; path: string; subject: string },
  cwd: string,
) {
  let body = "";
  try {
    body = await clickRpc.readGitBlob({ repo: found.repo, rev: found.rev, path: found.path });
  } catch (e) {
    body = String(e);
  }
  const rows = body.split("\n").map((line, index) => `${found.path}:${index + 1}:${line}`);
  openClickPanel(token, rows.join("\n"), cwd, {
    pattern: "",
    command: `git show ${found.rev.slice(0, 9)}:${found.path} · ${found.subject} · not in ${found.repo}`,
  });
}

export function dispatchClick(rawToken: string, cwd: string, source: CmdClickSource = "unknown") {
  return cmdClickRouter.dispatch({ token: rawToken, cwd, source });
}

// cwd to search from when a ⌘-click happens outside a terminal: the focused
// terminal tab's cwd (best proxy for "where am I"), else empty (run_click falls
// back to HOME).
const activeCwd = (): string => {
  const id = getFocusedTermId();
  return id ? tabMetaById(id)?.cwd ?? "" : "";
};

// The word under a viewport point in DOM text (preview / rg / markdown panels).
// Uses the terminal's scanner, so the same token reads identically everywhere.
function domWordAt(x: number, y: number): string {
  const range = document.caretRangeFromPoint?.(x, y);
  const node = range?.startContainer;
  if (!range || !node || node.nodeType !== Node.TEXT_NODE) return "";
  return tokenAtColumn(node.nodeValue ?? "", range.startOffset)?.text ?? "";
}

// SVG text (mermaid / d2 labels) has no caret range, so the character index comes
// from the SVG text API after transforming the click into user space.
export function svgWordAt(target: Element, x: number, y: number): string {
  const text = target.closest?.("text") as SVGTextContentElement | null;
  if (!text) return "";
  const content = text.textContent ?? "";
  if (!content.trim()) return "";
  try {
    const owner = (text as unknown as SVGGraphicsElement).ownerSVGElement;
    const ctm = (text as unknown as SVGGraphicsElement).getScreenCTM?.();
    if (owner && ctm) {
      const point = owner.createSVGPoint();
      point.x = x;
      point.y = y;
      const local = point.matrixTransform(ctm.inverse());
      const index = text.getCharNumAtPosition(local);
      if (index >= 0) return tokenAtColumn(content, index)?.text ?? "";
    }
  } catch {
    /* older engines: fall through to the whole label */
  }
  const words = content.trim().split(/\s+/);
  return words.length === 1 ? words[0] : "";
}

// Every non-terminal surface a ⌘-click routes from. Terminals self-handle (they
// own cell-to-pixel mapping); diagrams and SVG documents come in through here.
const CLICK_SURFACES = ".fs-preview, .rg-panel, .mdview-root, .md-body, .term-diagrams, .svg-document-viewer";
const CLICK_SKIP = ".fs-back, .rg-cfg, .rg-grep, .rg-file, .rg-hit, a, button, input, textarea, select";

function surfaceOf(el: HTMLElement): CmdClickSource {
  if (el.closest(".rg-panel")) return "results";
  if (el.closest(".term-diagrams, .svg-document-viewer")) return "diagram";
  if (el.closest(".mdview-root, .md-body")) return "markdown";
  return "preview";
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
      const surface = t.closest?.(CLICK_SURFACES);
      if (!surface) return;
      // A diagram rendered over a terminal is ours; the terminal grid is not.
      if (!t.closest(".term-diagrams") && (t.closest(".term-host") || t.closest(".xterm"))) return;
      if (t.closest(CLICK_SKIP)) return;
      const sel = window.getSelection()?.toString().trim() ?? "";
      const word = sel || svgWordAt(t, e.clientX, e.clientY) || domWordAt(e.clientX, e.clientY);
      if (!word) return;
      e.preventDefault();
      e.stopPropagation();
      void dispatchClick(word, activeCwd(), surfaceOf(t));
    },
    { capture: true },
  );
}

// A token that named several files (a bare `MdPanel.tsx`, a tail that repeats
// across packages) opens the same results panel a search would, one row per
// candidate, ranked closest first. Rows carry the token's line number so the
// preview lands on the right row whichever file the user picks.
function openRefChoices(
  token: string,
  paths: string[],
  line: number | undefined,
  cwd: string,
  via: "exact" | "fuzzy" = "exact",
) {
  const output = paths.map((p) => `${p}:${line ?? 1}:${dirOf(p, cwd)}`).join("\n");
  const verb = via === "fuzzy" ? "fzf" : "resolve";
  const count = `${paths.length} candidate${paths.length === 1 ? "" : "s"}`;
  openClickPanel(token, output, cwd, { pattern: "", command: `${verb} ${token} (${count})` });
}

// The directory a candidate lives in, relative to the terminal cwd when it sits
// underneath it, so the picker rows read as locations instead of full paths.
function dirOf(path: string, cwd: string): string {
  const dir = path.slice(0, path.lastIndexOf("/")) || "/";
  const base = cwd.replace(/\/$/, "");
  return base && dir.startsWith(`${base}/`) ? dir.slice(base.length + 1) : dir;
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
    `<a class="rg-grep" href="#">grep it</a> · ` +
    `<a class="rg-cfg" href="#">config</a></div>` +
    `<div class="rg-body">${body || '<div class="rg-plain">no matches</div>'}</div>`;

  el.querySelector<HTMLElement>(".rg-cfg")?.addEventListener("click", (e) => {
    e.preventDefault();
    openClickConfigPanel();
  });
  // The path rungs answered, and the answer was wrong: run the rule anyway.
  el.querySelector<HTMLElement>(".rg-grep")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void runClickRule(query, cwd);
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
  const rules = settings.clickRules.$() ?? DEFAULT_CLICK_RULES;
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
      settings.clickRules.$(parsed);
      msg.textContent = "saved";
    } catch (e) {
      msg.textContent = String(e);
    }
  });
  el.querySelector<HTMLElement>(".rg-cfg-reset")?.addEventListener("click", () => {
    settings.clickRules.$(DEFAULT_CLICK_RULES);
    ta.value = JSON.stringify(DEFAULT_CLICK_RULES, null, 2);
    msg.textContent = "reset";
  });
}
