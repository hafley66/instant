// Per-path file/diff preview tabs. Previews are dynamic dock panels keyed by path
// (preview:<path>), like xterm sessions. This module owns each instance's content
// node and renders into it; reactdock hosts the node. No untitled buffers: every
// preview names a path.
import { invoke } from "@tauri-apps/api/core";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { codeToHtml } from "shiki";
import { store } from "./state";
import { addPreviewPanel, isPreviewOpen, activatePreviewPanel } from "./reactdock";
import { baseName, escapeHtml, tildify, IMAGE_EXTS, MD_EXTS, SHIKI_LANG } from "./core";

export type PreviewInst = { el: HTMLElement; line?: number };
// Exported so favorites' locateFav can park a synthetic (`fav:…`) entry here and
// share the theme-sync re-render loop below (preserves the v1 single-map behavior).
export const previewInsts = new Map<string, PreviewInst>();

// Raw text of the currently-rendered text preview, keyed by its content node, so
// the meta-bar "copy" button can grab it without re-reading the file. Images
// have no entry (and no copy button).
const previewTextByNode = new WeakMap<HTMLElement, string>();

// Internal routing: which panel a file preview was opened FROM (an rg results
// panel), so the preview's "← back" returns there. Keyed by preview path, value
// is the origin panel key (e.g. `rg:<query>`). Set by the rg hit click before
// openPreviewPanel renders.
export const previewOrigin = new Map<string, string>();

// Open (or focus) the preview tab for `path`. A `line` (>0) selects the
// line-numbered source view scrolled to that row; otherwise the rendered view
// (image / markdown / syntax-highlighted code).
export function openPreviewPanel(
  path: string,
  line?: number,
  direction: "within" | "right" = "within",
) {
  let inst = previewInsts.get(path);
  if (!inst) {
    const el = document.createElement("div");
    el.className = "fs-preview";
    inst = { el, line };
    previewInsts.set(path, inst);
    // Delegated so it survives renderPathInto's innerHTML rewrites: "← back"
    // returns to the originating panel (internal routing).
    el.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const cp = t.closest<HTMLElement>(".fs-copy");
      if (cp) {
        const text = previewTextByNode.get(el);
        if (text != null) {
          navigator.clipboard.writeText(text).then(() => {
            cp.textContent = "copied";
            setTimeout(() => (cp.textContent = "copy"), 1200);
          }).catch(console.error);
        }
        return;
      }
      const b = t.closest<HTMLElement>(".fs-back");
      if (!b) return;
      const origin = b.getAttribute("data-origin");
      if (origin) activatePreviewPanel(origin);
    });
  } else {
    inst.line = line;
  }
  addPreviewPanel(path, path.split("/").pop() ?? path, inst.el, direction);
  renderPathInto(inst.el, path, line);
}

// Render `path` into `node`: images via read_image, markdown via marked, a
// `line` request via the line-numbered source view, everything else via shiki.
async function renderPathInto(node: HTMLElement, path: string, line?: number) {
  const name = path.split("/").pop() ?? path;
  const ext = (name.includes(".") ? name.split(".").pop()! : "").toLowerCase();
  const empty = (s: string) => `<div class="fs-preview-empty">${s}</div>`;
  const origin = previewOrigin.get(path);
  const back = origin
    ? `<button class="fs-back" data-origin="${escapeHtml(origin)}" title="back to ${escapeHtml(origin)}">← back</button> `
    : "";
  const isImage = !line && IMAGE_EXTS.has(ext);
  // Copy the rendered text to the clipboard (text previews only; the handler in
  // openPreviewPanel reads previewTextByNode). Images get no button.
  const copy = isImage ? "" : `<button class="fs-copy" title="copy text">copy</button> `;
  const meta =
    `<div class="fs-preview-meta">${back}${copy}<span class="fs-preview-name">${escapeHtml(name)}</span>` +
    `<br><span>${escapeHtml(line ? `${path}:${line}` : path)}</span></div>`;
  previewTextByNode.delete(node); // cleared until the new text loads
  node.innerHTML = meta + empty("loading…");

  if (isImage) {
    try {
      const url = await invoke<string>("read_image", { path });
      node.innerHTML = meta + `<img class="fs-preview-img" src="${url}" alt="" />`;
    } catch (e) {
      node.innerHTML = meta + empty(String(e));
    }
    return;
  }

  let text: string;
  try {
    text = await invoke<string>("read_text", { path });
  } catch (e) {
    node.innerHTML = meta + empty(String(e));
    return;
  }
  previewTextByNode.set(node, text); // back the meta-bar copy button

  if (line) {
    // Whole file with line numbers; the target row is highlighted and scrolled
    // to center. Syntax-highlighted via shiki (per-line spans, same trick as the
    // rg panel), falling back to escaped text if the language is unknown / shiki
    // fails. Capped so a giant source file stays responsive.
    const lines = text.split("\n");
    const CAP = 2000;
    const hi = Math.min(lines.length, CAP);
    const theme = store.get().mode === "dark" ? "github-dark" : "github-light";
    const lang = SHIKI_LANG[ext] || SHIKI_LANG[name.toLowerCase()] || "text";
    let hl: string[] | null = null;
    try {
      const html = await codeToHtml(lines.slice(0, hi).join("\n"), { lang, theme });
      hl = Array.from(
        new DOMParser().parseFromString(html, "text/html").querySelectorAll(".line"),
      ).map((s) => s.innerHTML);
    } catch {
      hl = null;
    }
    const body = lines
      .slice(0, hi)
      .map((l, i) => {
        const n = i + 1;
        const cls = n === line ? "src-line on" : "src-line";
        const num = String(n).padStart(4, " ");
        const code = hl?.[i] ?? escapeHtml(l);
        return `<div class="${cls}" data-n="${n}"><span class="src-n">${num}</span>${code || " "}</div>`;
      })
      .join("");
    const tail = hi < lines.length ? `<div class="src-elide">… ${lines.length - hi} more lines</div>` : "";
    node.innerHTML = meta + `<pre class="src-pre">${body}${tail}</pre>`;
    node.querySelector(".src-line.on")?.scrollIntoView({ block: "center" });
    return;
  }

  if (MD_EXTS.has(ext)) {
    const html = DOMPurify.sanitize(await marked.parse(text));
    node.innerHTML = meta + `<div class="md-body">${html}</div>`;
    return;
  }

  const theme = store.get().mode === "dark" ? "github-dark" : "github-light";
  const lang = SHIKI_LANG[ext] || SHIKI_LANG[name.toLowerCase()] || "text";
  try {
    const html = await codeToHtml(text, { lang, theme });
    node.innerHTML = meta + `<div class="code-body">${html}</div>`;
  } catch {
    node.innerHTML = meta + `<pre class="code-plain">${escapeHtml(text)}</pre>`;
  }
}

// ---- working-tree diff panels ----
// Working-tree diff panel for a worktree (staged+unstaged vs HEAD, untracked
// appended). Rendered with shiki's `diff` grammar in a split-right preview tab,
// keyed so reopening re-renders fresh.
const diffInsts = new Map<string, { el: HTMLElement }>();
export function openDiffPanel(wtPath: string) {
  if (!wtPath) return;
  const key = `diff:${wtPath}`;
  let inst = diffInsts.get(key);
  if (!inst) {
    inst = { el: document.createElement("div") };
    inst.el.className = "fs-preview diff-preview";
    diffInsts.set(key, inst);
  }
  addPreviewPanel(key, `diff · ${baseName(wtPath)}`, inst.el, "right");
  renderDiffInto(inst.el, wtPath);
}
async function renderDiffInto(node: HTMLElement, wtPath: string) {
  const meta =
    `<div class="fs-preview-meta"><span class="fs-preview-name">git diff</span>` +
    `<br><span>${escapeHtml(tildify(wtPath))}</span></div>`;
  const empty = (s: string) => `<div class="fs-preview-empty">${escapeHtml(s)}</div>`;
  node.innerHTML = meta + empty("loading…");
  let text: string;
  try {
    text = await invoke<string>("git_diff", { path: wtPath });
  } catch (e) {
    node.innerHTML = meta + empty(String(e));
    return;
  }
  if (!text.trim()) {
    node.innerHTML = meta + empty("no changes — working tree clean");
    return;
  }
  const theme = store.get().mode === "dark" ? "github-dark" : "github-light";
  try {
    const html = await codeToHtml(text, { lang: "diff", theme });
    // Band each row by its leading char (+/-/@) — shiki colors the text but
    // doesn't tint line backgrounds. Tag the .line spans in document order
    // against the raw lines, then re-serialize.
    const doc = new DOMParser().parseFromString(html, "text/html");
    const raw = text.split("\n");
    doc.querySelectorAll<HTMLElement>(".line").forEach((el, i) => {
      const c = raw[i]?.[0];
      if (c === "+") el.classList.add("add");
      else if (c === "-") el.classList.add("del");
      else if (c === "@") el.classList.add("hunk");
    });
    node.innerHTML = meta + `<div class="code-body diff-body">${doc.body.innerHTML}</div>`;
  } catch {
    node.innerHTML = meta + `<pre class="code-plain">${escapeHtml(text)}</pre>`;
  }
}

// On theme flip, re-render the open previews so syntax colors track light/dark
// (the line-numbered source view is shiki-colored too now). Closed instances keep
// their cached node; reopening re-renders. Diff panels are shiki-colored too.
export function initPreviewThemeSync() {
  store.subscribe(() => {
    for (const [path, inst] of previewInsts) {
      if (isPreviewOpen(path)) renderPathInto(inst.el, path, inst.line);
    }
    for (const [key, inst] of diffInsts) {
      if (isPreviewOpen(key)) renderDiffInto(inst.el, key.slice("diff:".length));
    }
  }, ["mode"]);
}
