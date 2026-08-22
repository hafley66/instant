// Per-path file/diff preview tabs. Previews are dynamic dock panels keyed by path
// (preview:<path>), like xterm sessions. This module owns each instance's content
// node and renders into it; reactdock hosts the node. No untitled buffers: every
// preview names a path.
import { invoke } from "./generated/native";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { codeToHtml } from "shiki";
import { routePath } from "./plugin";
import {
  addPreviewPanel,
  allPanelIds,
  isPreviewOpen,
  activatePreviewPanel,
  focusPanelById,
  onDockChange,
  panelVisibility$,
  previewPanelId,
  setPreviewRehydration,
  togglePanel,
} from "./reactdock";
import { savePluginState } from "./pluginState";
import { claimFsWatch } from "./fsWatch";
import { baseName, escapeHtml, getHomeDir, tildify, IMAGE_EXTS } from "./core";
import { FileImageViewer } from "./1_FileImageViewer";
import { renderD2 } from "@hafley66/md";
import { resolveD2Preview } from "./0_d2Preview";
import { browserFileUrl } from "./0_htmlFileUrl";
import { documentHref } from "./0_documentHref";
import { openExternalUrl } from "./0_openExternal";
import { MonacoCodeViewer } from "./0_MonacoCodeViewer";
import { shareReplay, type Subscription } from "rxjs";
import { visibleFileWatch$ } from "./0_visibleFileWatch";
import { liveProbe } from "./0_liveProbe";
import { settings } from "./0_settings";

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
  const extension = path.split("/").pop()?.split(".").pop()?.toLowerCase() ?? "";
  // Command-click resolution has already located relative files. An
  // extension-bearing leaf can route immediately, avoiding list_dir(path),
  // which enumerates a directory merely to learn that a file is ENOTDIR.
  // This covers images, PDF, D2, Markdown, HTML, and ordinary source files.
  if (extension) {
    const browserUrl = !line && browserFileUrl(path, getHomeDir());
    if (browserUrl) {
      const { openBrowserTab } = await import("./browser");
      await openBrowserTab(browserUrl);
      return;
    }
    openPreviewPanel(path, line);
    return;
  }
  try {
    await invoke("list_dir", { path });
    savePluginState<{ root?: string }>("files", { root: path });
    if (allPanelIds().includes("files")) focusPanelById("files");
    else togglePanel("files");
    return;
  } catch {
    // A file produces ENOTDIR. Continue through the existing file routes.
  }
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
  timer?: ReturnType<typeof setTimeout>;
  visibility?: Subscription;
  watcher?: Subscription;
  visible?: boolean;
};
const previewWatches = new Map<string, PreviewWatch>();
// Editors write in bursts (truncate + write, or rename-over); coalesce so one
// save is one re-render.
const WATCH_DEBOUNCE_MS = 75;

function watchPreview(path: string) {
  if (previewWatches.has(path)) return;
  const w: PreviewWatch = {};
  previewWatches.set(path, w);
  const visibility$ = panelVisibility$(previewPanelId(path)).pipe(
    shareReplay({ bufferSize: 1, refCount: true }),
  );
  w.visibility = visibility$.subscribe((visible) => {
    w.visible = visible;
    if (!visible) clearTimeout(w.timer);
  });
  w.watcher = visibleFileWatch$(visibility$, () =>
    claimFsWatch(path, () => {
      clearTimeout(w.timer);
      w.timer = setTimeout(() => {
        const inst = previewInsts.get(path);
        if (!inst || !isPreviewOpen(path) || !w.visible) return;
        void renderPathInto(inst.el, path, inst.line);
      }, WATCH_DEBOUNCE_MS);
    }),
  ).subscribe({ error: console.error });
}

function releasePreviewWatch(path: string) {
  const w = previewWatches.get(path);
  if (!w) return;
  previewWatches.delete(path);
  clearTimeout(w.timer);
  w.visibility?.unsubscribe();
  w.watcher?.unsubscribe();
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
function mountMediaViewer(node: HTMLElement, path: string, media: { url?: string; svg?: string; pdf?: string }) {
  liveProbe.record({ kind: "mount", name: "preview.mediaViewer", scope: path, detail: { svg: Boolean(media.svg), pdf: Boolean(media.pdf), url: Boolean(media.url) } });
  node.insertAdjacentHTML("beforeend", `<div class="fs-preview-media"></div>`);
  const mount = node.querySelector<HTMLElement>(".fs-preview-media");
  if (!mount) return;
  const root = createRoot(mount);
  previewMediaRoots.set(node, root);
  root.render(createElement(FileImageViewer, {
    path,
    ...media,
    probeRoot: node,
    onOpenHref: (href: string) => openDocumentHrefInInstant(href, path),
  }));
}

function mountCodeViewer(node: HTMLElement, path: string, text: string, line?: number) {
  node.insertAdjacentHTML("beforeend", `<div class="fs-preview-code"></div>`);
  const mount = node.querySelector<HTMLElement>(".fs-preview-code");
  if (!mount) return;
  const root = createRoot(mount);
  previewMediaRoots.set(node, root);
  root.render(createElement(MonacoCodeViewer, {
    id: path,
    path,
    text,
    line,
    dark: settings.mode.$() === "dark",
    onText: (value: string) => previewTextByNode.set(node, value),
  }));
}

// Render `path` into `node`: images via read_image, markdown via marked, a
// `line` request via the line-numbered source view, everything else via shiki.
async function renderPathInto(node: HTMLElement, path: string, line?: number) {
  liveProbe.record({ kind: "operation", name: "preview.renderPathInto", scope: path, detail: { line: line ?? 0 } });
  const seq = (renderSeq.get(node) ?? 0) + 1;
  renderSeq.set(node, seq);
  const stale = () => renderSeq.get(node) !== seq;
  previewMediaRoots.get(node)?.unmount();
  previewMediaRoots.delete(node);
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
          const dark = settings.mode.$() === "dark";
          const svg = await renderD2(source, dark);
          liveProbe.record({ kind: "operation", name: "preview.renderD2", scope: sourcePath, detail: { dark, sourceBytes: source.length, svgBytes: svg.length } });
          return { source, svg };
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
    if (stale()) return;
    node.innerHTML = meta;
    mountCodeViewer(node, path, text, line);
    return;
  }

  node.innerHTML = meta;
  mountCodeViewer(node, path, text);
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
  const theme = settings.mode.$() === "dark" ? "github-dark" : "github-light";
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
  settings.mode.$.subscribe(() => {
    for (const [path, inst] of previewInsts) {
      if (isPreviewOpen(path)) renderPathInto(inst.el, path, inst.line);
    }
    for (const [key, inst] of diffInsts) {
      if (isPreviewOpen(key)) renderDiffInto(inst.el, key.slice("diff:".length));
    }
  });
}
