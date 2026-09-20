import { invoke } from "./generated/native";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FileImageViewer } from "./1_FileImageViewer";
import { MonacoCodeViewer } from "./0_MonacoCodeViewer";
import { renderD2, renderMermaidSvg } from "@hafley66/md";
import { resolveD2Preview } from "./0_d2Preview";
import { DiagramRenderCache } from "./0_diagramRenderCache";
import { escapeHtml, IMAGE_EXTS } from "./core";
import { liveProbe } from "./0_liveProbe";
import { settings } from "./0_settings";

export const previewTextByNode = new WeakMap<HTMLElement, string>();
export const previewOrigin = new Map<string, string>();
const previewMediaRoots = new WeakMap<HTMLElement, Root>();
const renderSeq = new WeakMap<HTMLElement, number>();
const rendered = new WeakMap<HTMLElement, { kind: string; data: string; path: string; line?: number; dark: boolean }>();
const diagrams = new DiagramRenderCache();

export function disposePreview(node: HTMLElement) {
  renderSeq.set(node, (renderSeq.get(node) ?? 0) + 1);
  previewMediaRoots.get(node)?.unmount();
  previewMediaRoots.delete(node);
  previewTextByNode.delete(node);
  rendered.delete(node);
}

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
    onOpenHref: (href: string) => import("./preview").then(({ openDocumentHrefInInstant }) => openDocumentHrefInInstant(href, path)),
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

// Read before unmounting: unchanged watch notifications and repeated command
// clicks retain the loaded document, its zoom, and its React root.
export async function renderPathInto(node: HTMLElement, path: string, line?: number) {
  const seq = (renderSeq.get(node) ?? 0) + 1;
  renderSeq.set(node, seq);
  const stale = () => renderSeq.get(node) !== seq;
  const dark = settings.mode.$() === "dark";
  const name = path.split("/").pop() ?? path;
  const ext = (name.includes(".") ? name.split(".").pop()! : "").toLowerCase();
  const empty = (text: string) => `<div class="fs-preview-empty">${escapeHtml(text)}</div>`;
  const origin = previewOrigin.get(path);
  const back = origin ? `<button class="fs-back" data-origin="${escapeHtml(origin)}">← back</button> ` : "";
  const media = !line && (IMAGE_EXTS.has(ext) || ext === "pdf");
  const copy = media ? "" : `<button class="fs-copy" title="copy text">copy</button> `;
  const meta = `<div class="fs-preview-meta">${back}${copy}<span class="fs-preview-name">${escapeHtml(name)}</span><br><span>${escapeHtml(line ? `${path}:${line}` : path)}</span></div>`;
  if (!rendered.has(node)) node.innerHTML = meta + empty("loading…");
  let kind = "code", data = "", displayPath = path, text: string | undefined;
  try {
    if (!line && ext === "d2") {
      const preview = await resolveD2Preview(path,
        (sibling) => invoke<string>("read_text", { path: sibling }),
        (sibling) => stale()
          ? Promise.reject(new Error("Preview superseded"))
          : invoke<string>("read_image", { path: sibling }),
        async () => {
          const source = await invoke<string>("read_text", { path });
          if (stale()) throw new Error("Preview superseded");
          const svg = await diagrams.render("d2", source, dark, () => renderD2(source, dark));
          return { source, svg };
        });
      kind = preview.svg !== undefined ? "svg" : "url";
      data = preview.svg ?? preview.url ?? "";
      text = preview.source;
      displayPath = preview.path;
    } else if (!line && (ext === "mmd" || ext === "mermaid")) {
      text = await invoke<string>("read_text", { path });
      if (stale()) return;
      const source = text;
      data = await diagrams.render("mermaid", source, dark, () => renderMermaidSvg(source, dark));
      kind = "svg";
    } else if (media && ext !== "svg") {
      kind = ext === "pdf" ? "pdf" : "url";
      data = await invoke<string>("read_image", { path });
    } else {
      data = await invoke<string>("read_text", { path });
      kind = media ? "svg" : "code";
      if (kind === "code") text = data;
    }
    if (stale()) return;
    const previous = rendered.get(node);
    // Only code colors depend on the theme here. Compiled diagrams already
    // carry their theme in `data`; existing SVG/image documents do not.
    if (previous?.kind === kind && previous.data === data && previous.path === displayPath
      && previous.line === line && (kind !== "code" || previous.dark === dark)) return;
    if (text !== undefined) previewTextByNode.set(node, text);
    else previewTextByNode.delete(node);
    previewMediaRoots.get(node)?.unmount();
    previewMediaRoots.delete(node);
    node.innerHTML = meta;
    rendered.set(node, { kind, data, path: displayPath, line, dark });
    liveProbe.record({ kind: "operation", name: "preview.renderPathInto", scope: path, detail: { line: line ?? 0 } });
    if (kind === "code") mountCodeViewer(node, path, data, line);
    else mountMediaViewer(node, displayPath, { [kind]: data });
  } catch (error) {
    if (stale()) return;
    disposePreview(node);
    node.innerHTML = meta + empty(String(error));
  }
}
