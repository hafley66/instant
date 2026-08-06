// Per-path file/diff preview tabs. Previews are dynamic dock panels keyed by path
// (preview:<path>), like xterm sessions. This module owns each instance's content
// node and renders into it; reactdock hosts the node. No untitled buffers: every
// preview names a path.
import { invoke } from "./generated/native";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { codeToHtml } from "shiki";
import { store } from "./state";
import { routePath } from "./plugin";
import {
  addPreviewPanel,
  isPreviewOpen,
  activatePreviewPanel,
  onDockChange,
  setPreviewRehydration,
} from "./reactdock";
import { claimFsWatch } from "./fsWatch";
import { baseName, escapeHtml, getHomeDir, tildify, IMAGE_EXTS, SHIKI_LANG } from "./core";
import { FileImageViewer } from "./1_FileImageViewer";
import { renderD2 } from "./mdview/d2";
import { resolveD2Preview } from "./0_d2Preview";
import { browserFileUrl } from "./0_htmlFileUrl";
import { documentHref } from "./0_documentHref";
import { openExternalUrl } from "./0_openExternal";

export type PreviewInst = { el: HTMLElement; line?: number };
// Exported so favorites' locateFav can park a synthetic (`fav:…`) entry here and
// share the theme-sync re-render loop below (preserves the v1 single-map behavior).
export const previewInsts = new Map<string, PreviewInst>();

// Raw text of the currently-rendered text preview, keyed by its content node, so
// the meta-bar "copy" button can grab it without re-reading the file. Images
// have no entry (and no copy button).
const previewTextByNode = new WeakMap<HTMLElement, string>();
const previewMediaRoots = new WeakMap<HTMLElement, Root>();

// Internal routing: which panel a file preview was opened FROM (an rg results
// panel), so the preview's "← back" returns there. Keyed by preview path, value
// is the origin panel key (e.g. `rg:<query>`). Set by the rg hit click before
// openPreviewPanel renders.
export const previewOrigin = new Map<string, string>();

// Open (or focus) the preview tab for `path`. A `line` (>0) selects the
// line-numbered source view scrolled to that row; otherwise the rendered view
// (image / syntax-highlighted code). Registered plugin routes run first, so
// Markdown opens in mdview without preview importing that feature directly.
export function openPreviewPanel(
  path: string,
  line?: number,
  direction: "within" | "right" = "within",
) {
  if (!line && routePath(path)) return;
  const inst = ensureInst(path, line);
  addPreviewPanel(path, path.split("/").pop() ?? path, inst.el, direction, {
    ...(line ? { line } : {}),
  });
  watchPreview(path);
  renderPathInto(inst.el, path, line);
}

export async function openPathInInstant(path: string, line?: number): Promise<void> {
  const browserUrl = browserFileUrl(path, getHomeDir());
  if (browserUrl) {
    const { openBrowserTab } = await import("./browser");
    await openBrowserTab(browserUrl);
    return;
  }
  openPreviewPanel(path, line);
}

export async function openDocumentHrefInInstant(href: string, sourcePath: string): Promise<void> {
  const target = documentHref(href, sourcePath);
  if (target) {
    await openPathInInstant(target.path, target.line);
    return;
  }
  await openExternalUrl(href);
}

// The content node for `path`, created on first use. Also used by the restore
// path, which rebuilds the node for a tab that came back from the saved layout.
function ensureInst(path: string, line?: number): PreviewInst {
  const existing = previewInsts.get(path);
  if (existing) {
    existing.line = line;
    return existing;
  }
  const el = document.createElement("div");
  el.className = "fs-preview";
  const inst: PreviewInst = { el, line };
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
  return inst;
}

// ---- live reload ----
// Every open preview tab claims an fs watch on its path, so an edit on disk
// repaints the tab instead of waiting for an app reload. Claims are keyed by
// preview path and released when the tab closes (reconciled off the dock's
// change stream in initPreviewWatch, since dock panels can also be closed by
// keybinding, layout restore, or the tab's own ✕).
type PreviewWatch = {
  release?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  dead?: boolean;
};
const previewWatches = new Map<string, PreviewWatch>();
// Editors write in bursts (truncate + write, or rename-over); coalesce so one
// save is one re-render.
const WATCH_DEBOUNCE_MS = 75;

function watchPreview(path: string) {
  if (previewWatches.has(path)) return;
  const w: PreviewWatch = {};
  previewWatches.set(path, w);
  claimFsWatch(path, () => {
    clearTimeout(w.timer);
    w.timer = setTimeout(() => {
      const inst = previewInsts.get(path);
      if (!inst || !isPreviewOpen(path)) return;
      void renderPathInto(inst.el, path, inst.line);
    }, WATCH_DEBOUNCE_MS);
  })
    // The claim is async: if the tab closed while it was in flight, drop it now.
    .then((release) => (w.dead ? release() : (w.release = release)))
    .catch(console.error);
}

function releasePreviewWatch(path: string) {
  const w = previewWatches.get(path);
  if (!w) return;
  previewWatches.delete(path);
  w.dead = true;
  clearTimeout(w.timer);
  w.release?.();
}

// Release the watch for any preview whose tab is gone. Registered once at
// startup from main.ts.
export function initPreviewWatch() {
  onDockChange(() => {
    for (const path of [...previewWatches.keys()]) {
      if (!isPreviewOpen(path)) releasePreviewWatch(path);
    }
  });
}

// ---- restore across reloads ----
// A preview key is restorable when its content can be re-derived from the key
// alone: a file path (re-read from disk) or `diff:<worktree>` (re-run git
// diff). The other keys parked in this panel family — rg results, favorites,
// ledger turns — were rendered from in-memory data by their own modules, so
// they stay husks and the dock drops them.
const DIFF = "diff:";
function canRestore(key: string): boolean {
  if (key.startsWith(DIFF)) return key.length > DIFF.length;
  return key.startsWith("/") || key.startsWith("~/");
}

// Rebuild the content node for a restored tab and kick off its render. Called
// by the dock when a preview panel mounts with no node (see PreviewPanel), so
// the read happens when the tab is first shown, not for every tab at boot.
function restorePreview(key: string, params: Record<string, unknown>): HTMLElement | null {
  if (key.startsWith(DIFF)) {
    const wtPath = key.slice(DIFF.length);
    const inst = ensureDiffInst(key);
    void renderDiffInto(inst.el, wtPath);
    return inst.el;
  }
  if (!canRestore(key)) return null;
  const rawLine = params.line;
  const line = typeof rawLine === "number" && rawLine > 0 ? rawLine : undefined;
  const inst = ensureInst(key, line);
  watchPreview(key);
  void renderPathInto(inst.el, key, line);
  return inst.el;
}

// Registered once at startup from main.ts, before the dock mounts (the restore
// runs inside dockview's onReady).
export function initPreviewRestore() {
  setPreviewRehydration({ canRestore, restore: restorePreview });
}

// Monotonic render token per content node. A watch fire and a theme flip can
// both be mid-flight over the same node; only the newest render may write.
const renderSeq = new WeakMap<HTMLElement, number>();
// The pane itself is overflow:hidden — the inner body owns the single scroll.
const SCROLLER = ".src-pre, .code-body, .code-plain";

function mountMediaViewer(node: HTMLElement, path: string, media: { url?: string; svg?: string; pdf?: string }) {
  node.insertAdjacentHTML("beforeend", `<div class="fs-preview-media"></div>`);
  const mount = node.querySelector<HTMLElement>(".fs-preview-media");
  if (!mount) return;
  const root = createRoot(mount);
  previewMediaRoots.set(node, root);
  root.render(createElement(FileImageViewer, {
    path,
    ...media,
    onOpenHref: (href: string) => openDocumentHrefInInstant(href, path),
  }));
}

// Render `path` into `node`: images via read_image, markdown via marked, a
// `line` request via the line-numbered source view, everything else via shiki.
async function renderPathInto(node: HTMLElement, path: string, line?: number) {
  const seq = (renderSeq.get(node) ?? 0) + 1;
  renderSeq.set(node, seq);
  const stale = () => renderSeq.get(node) !== seq;
  previewMediaRoots.get(node)?.unmount();
  previewMediaRoots.delete(node);
  // A re-render from a file change (or theme flip) must not yank the reader back
  // to the top, so carry the scroll offset across the innerHTML rewrite.
  const prevScroll = node.querySelector<HTMLElement>(SCROLLER)?.scrollTop ?? 0;
  const restoreScroll = () => {
    if (prevScroll <= 0) return false;
    const el = node.querySelector<HTMLElement>(SCROLLER);
    if (!el) return false;
    el.scrollTop = prevScroll;
    return true;
  };
  const name = path.split("/").pop() ?? path;
  const ext = (name.includes(".") ? name.split(".").pop()! : "").toLowerCase();
  const empty = (s: string) => `<div class="fs-preview-empty">${s}</div>`;
  const origin = previewOrigin.get(path);
  const back = origin
    ? `<button class="fs-back" data-origin="${escapeHtml(origin)}" title="back to ${escapeHtml(origin)}">← back</button> `
    : "";
  const isImage = !line && IMAGE_EXTS.has(ext);
  const isPdf = !line && ext === "pdf";
  // Copy the rendered text to the clipboard (text previews only; the handler in
  // openPreviewPanel reads previewTextByNode). Images get no button.
  const copy = isImage || isPdf ? "" : `<button class="fs-copy" title="copy text">copy</button> `;
  const meta =
    `<div class="fs-preview-meta">${back}${copy}<span class="fs-preview-name">${escapeHtml(name)}</span>` +
    `<br><span>${escapeHtml(line ? `${path}:${line}` : path)}</span></div>`;
  previewTextByNode.delete(node); // cleared until the new text loads
  node.innerHTML = meta + empty("loading…");

  if (isPdf) {
    try {
      const pdf = await invoke<string>("read_image", { path });
      if (stale()) return;
      node.innerHTML = meta;
      mountMediaViewer(node, path, { pdf });
    } catch (error) {
      if (!stale()) node.innerHTML = meta + empty(String(error));
    }
    return;
  }

  if (isImage && ext === "svg") {
    try {
      const svg = await invoke<string>("read_text", { path });
      if (stale()) return;
      node.innerHTML = meta;
      mountMediaViewer(node, path, { svg });
    } catch (error) {
      if (!stale()) node.innerHTML = meta + empty(String(error));
    }
    return;
  }

  if (!line && ext === "d2") {
    try {
      const preview = await resolveD2Preview(
        path,
        (sibling) => invoke<string>("read_text", { path: sibling }),
        (sibling) => invoke<string>("read_image", { path: sibling }),
        async (sourcePath) => {
          const source = await invoke<string>("read_text", { path: sourcePath });
          return { source, svg: await renderD2(source, store.get().mode === "dark") };
        },
      );
      if (stale()) return;
      if (preview.source) previewTextByNode.set(node, preview.source);
      node.innerHTML = meta;
      mountMediaViewer(node, preview.path, { url: preview.url, svg: preview.svg });
    } catch (error) {
      if (!stale()) node.innerHTML = meta + empty(String(error));
    }
    return;
  }

  if (isImage) {
    try {
      const url = await invoke<string>("read_image", { path });
      if (stale()) return;
      node.innerHTML = meta;
      mountMediaViewer(node, path, { url });
    } catch (e) {
      if (stale()) return;
      node.innerHTML = meta + empty(String(e));
    }
    return;
  }

  let text: string;
  try {
    text = await invoke<string>("read_text", { path });
  } catch (e) {
    if (stale()) return;
    node.innerHTML = meta + empty(String(e));
    return;
  }
  if (stale()) return;
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
    if (stale()) return;
    node.innerHTML = meta + `<pre class="src-pre">${body}${tail}</pre>`;
    // Only re-center on the target row for a fresh open; a refresh of a file the
    // user has already scrolled keeps their position.
    if (!restoreScroll()) node.querySelector(".src-line.on")?.scrollIntoView({ block: "center" });
    return;
  }

  const theme = store.get().mode === "dark" ? "github-dark" : "github-light";
  const lang = SHIKI_LANG[ext] || SHIKI_LANG[name.toLowerCase()] || "text";
  try {
    const html = await codeToHtml(text, { lang, theme });
    if (stale()) return;
    node.innerHTML = meta + `<div class="code-body">${html}</div>`;
  } catch {
    if (stale()) return;
    node.innerHTML = meta + `<pre class="code-plain">${escapeHtml(text)}</pre>`;
  }
  restoreScroll();
}

// ---- working-tree diff panels ----
// Working-tree diff panel for a worktree (staged+unstaged vs HEAD, untracked
// appended). Rendered with shiki's `diff` grammar in a split-right preview tab,
// keyed so reopening re-renders fresh.
const diffInsts = new Map<string, { el: HTMLElement }>();
function ensureDiffInst(key: string): { el: HTMLElement } {
  let inst = diffInsts.get(key);
  if (!inst) {
    inst = { el: document.createElement("div") };
    inst.el.className = "fs-preview diff-preview";
    diffInsts.set(key, inst);
  }
  return inst;
}
export function openDiffPanel(wtPath: string) {
  if (!wtPath) return;
  const key = `${DIFF}${wtPath}`;
  const inst = ensureDiffInst(key);
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
