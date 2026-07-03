// Meme generator + Slack emoji maker plugin.
// Requires ImageMagick 6 (convert) or 7 (magick) on PATH for Slack emoji export.

import { invoke } from "@tauri-apps/api/core";
import { dirname, homeDir } from "@tauri-apps/api/path";
import { createElement, useEffect, useRef, useState, useCallback } from "react";
import { createRoot, type Root } from "react-dom/client";
import { registerPlugin } from "./plugin";
import { setFilePickerOpen } from "./overlayGuard";
import { MemeTree } from "./memeTree";
import { MemeLayers } from "./memeLayers";
import type { DirListing, FsEntry } from "./state";

const STORAGE_KEY = "meme:lastFolder";
const MEME_STATE_KEY = "meme:state";
const MEME_UI_KEY = "meme:ui";
const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
  "avif",
  "ico",
]);

interface TextBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextLayer {
  id: string;
  text: string;
  size: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  caps: boolean;
  xPct: number;
  yPct: number;
}

interface MemeState {
  folder: string;
  entries: FsEntry[];
  currentPath: string;
  currentDataUrl: string;
  image: HTMLImageElement | null;
  naturalWidth: number;
  naturalHeight: number;
  layers: TextLayer[];
  activeLayerId: string;
  dragLayerId: string | null;
  textBoxes: ({ id: string } & TextBox)[] | null;
}

const DEFAULT_LAYERS: TextLayer[] = [
  {
    id: "top",
    text: "",
    size: 48,
    fill: "#ffffff",
    stroke: "#000000",
    strokeWidth: 4,
    caps: true,
    xPct: 0.5,
    yPct: 0.08,
  },
  {
    id: "bottom",
    text: "",
    size: 48,
    fill: "#ffffff",
    stroke: "#000000",
    strokeWidth: 4,
    caps: true,
    xPct: 0.5,
    yPct: 0.92,
  },
];

const state: MemeState = {
  folder: "",
  entries: [],
  currentPath: "",
  currentDataUrl: "",
  image: null,
  naturalWidth: 0,
  naturalHeight: 0,
  layers: DEFAULT_LAYERS.map((l) => ({ ...l })),
  activeLayerId: DEFAULT_LAYERS[0].id,
  dragLayerId: null,
  textBoxes: null,
};

// Object URLs for files uploaded via the HTML file picker. The key is the
// synthetic `upload://<name>` path used in state.entries.
const uploadObjectUrls = new Map<string, string>();

// Cap the canvas backing store so Retina screenshots don't freeze the renderer.
const MAX_CANVAS_DIM = 1920;

let renderPending = false;
let homeDirResolved = "";
let folderPollTimer: number | undefined;
let pollInProgress = false;
let treeRoot: Root | null = null;
let layersRoot: Root | null = null;
let lastFolderPromise: Promise<string> = homeDir()
  .catch(() => "")
  .then((h) => {
    homeDirResolved = h;
    return h;
  });

export function registerMeme() {
  registerPlugin({
    id: "meme",
    panels: [
      {
        id: "meme",
        title: "Meme",
        icon: "🖼",
        iconLabel: "Meme",
        html: "",
        component: MemePanel,
      },
    ],
  });
}

interface MemeUi {
  sidebarWidth?: number;
  layersHeight?: number;
}

function readMemeUi(): MemeUi {
  try {
    const raw = localStorage.getItem(MEME_UI_KEY);
    return raw ? (JSON.parse(raw) as MemeUi) : {};
  } catch {
    return {};
  }
}

function saveMemeUi(patch: Partial<MemeUi>) {
  try {
    const next = { ...readMemeUi(), ...patch };
    localStorage.setItem(MEME_UI_KEY, JSON.stringify(next));
  } catch {
    // ignore localStorage failures
  }
}

function MemePanel() {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const thumbsRef = useRef<HTMLDivElement>(null);
  const layersRef = useRef<HTMLDivElement>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const [ui, setUi] = useState<MemeUi>(() => readMemeUi());

  useEffect(() => {
    wireMemePanel();
  }, []);

  const startSidebarDrag = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = thumbsRef.current?.offsetWidth ?? ui.sidebarWidth ?? 180;
    const onMove = (ev: PointerEvent) => {
      const w = clamp(startW + (ev.clientX - startX), 120, 400);
      setUi((prev) => ({ ...prev, sidebarWidth: w }));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const w = thumbsRef.current?.offsetWidth ?? startW;
      saveMemeUi({ sidebarWidth: clamp(w, 120, 400) });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [ui.sidebarWidth]);

  const startLayersDrag = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = layersRef.current?.offsetHeight ?? ui.layersHeight ?? 180;
    const onMove = (ev: PointerEvent) => {
      const h = clamp(startH + (ev.clientY - startY), 80, 400);
      setUi((prev) => ({ ...prev, layersHeight: h }));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const h = layersRef.current?.offsetHeight ?? startH;
      saveMemeUi({ layersHeight: clamp(h, 80, 400) });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [ui.layersHeight]);

  return (
    <div className="panel meme-panel" style={{ overflow: "hidden" }}>
      <div className="act-bar">
        <span className="spy-title">meme generator & slack emoji</span>
        <span id="meme-status" className="wt-count"></span>
        <span className="spy-spacer"></span>
        <button id="meme-copy" type="button">Copy</button>
        <button id="meme-save" type="button">Save…</button>
        <button id="meme-emoji" type="button">Slack Emoji</button>
      </div>
      <form id="meme-folder-form" className="wt-scan">
        <input id="meme-folder" autoComplete="off" spellCheck={false} placeholder="~/Pictures/memes" />
        <button type="submit">Load</button>
        <button id="meme-upload-files" type="button">Upload files</button>
        <button id="meme-upload-folder" type="button">Upload folder</button>
        <input
          id="meme-file-input"
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/bmp,image/svg+xml,image/avif,image/x-icon"
          multiple
          hidden
        />
        <input id="meme-folder-input" type="file" {...{ webkitdirectory: true }} multiple hidden />
        <span className="meme-hint">drop a folder or image here</span>
      </form>
      <div
        id="meme-workspace"
        ref={workspaceRef}
        className="meme-workspace"
        style={{ "--meme-sidebar-width": `${ui.sidebarWidth ?? 180}px` } as React.CSSProperties}
      >
        <div id="meme-thumbs" ref={thumbsRef} className="meme-thumbs panel-scroll"></div>
        <div
          className="meme-sash meme-sash-vertical"
          title="drag to resize"
          onPointerDown={startSidebarDrag}
        ></div>
        <div className="meme-stage">
          <div id="meme-canvas-wrap" ref={canvasWrapRef} className="meme-canvas-wrap">
            <canvas id="meme-canvas"></canvas>
          </div>
          <div className="meme-hint">drag text to move · click a layer below to edit</div>
        </div>
      </div>
      <div
        className="meme-sash meme-sash-horizontal"
        title="drag to resize"
        onPointerDown={startLayersDrag}
      ></div>
      <div
        id="meme-layers"
        ref={layersRef}
        className="meme-layers"
        style={{ "--meme-layers-height": `${ui.layersHeight ?? 180}px` } as React.CSSProperties}
      ></div>
      <dialog id="meme-save-dialog" className="meme-dialog">
        <form method="dialog">
          <div className="meme-dialog-title">Save meme</div>
          <input id="meme-save-path" autoComplete="off" spellCheck={false} />
          <div className="meme-dialog-actions">
            <button value="cancel">Cancel</button>
            <button id="meme-save-confirm" value="save">Save</button>
          </div>
        </form>
      </dialog>
    </div>
  );
}

function $(sel: string) {
  return document.querySelector(sel) as HTMLElement | null;
}

function wireMemePanel() {
  const form = $("#meme-folder-form");
  const folderInput = $("#meme-folder") as HTMLInputElement | null;
  const canvasWrap = $("#meme-canvas-wrap");

  if (!form || form.dataset.wired) return;
  form.dataset.wired = "1";

  // Restore last folder.
  lastFolderPromise.then(async (home) => {
    const saved = localStorage.getItem(STORAGE_KEY);
    const initial = saved || home || "";
    if (folderInput) folderInput.value = initial;
    if (initial) await loadFolder(initial);
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const path = folderInput?.value.trim();
    if (path) await loadFolder(path);
  });

  loadMemeState();

  $("#meme-copy")?.addEventListener("click", copyMeme);
  $("#meme-save")?.addEventListener("click", showSaveDialog);
  $("#meme-emoji")?.addEventListener("click", makeSlackEmoji);

  const fileInput = $("#meme-file-input") as HTMLInputElement | null;
  const folderFileInput = $("#meme-folder-input") as HTMLInputElement | null;

  function openFilePicker(input: HTMLInputElement) {
    setFilePickerOpen(true);
    input.click();
  }
  function endFilePicker() {
    setFilePickerOpen(false);
  }

  $("#meme-upload-files")?.addEventListener("click", () => fileInput && openFilePicker(fileInput));
  $("#meme-upload-folder")?.addEventListener("click", () => folderFileInput && openFilePicker(folderFileInput));
  fileInput?.addEventListener("change", () => {
    endFilePicker();
    if (fileInput.files) handleUploadedFiles(fileInput.files);
    fileInput.value = "";
  });
  folderFileInput?.addEventListener("change", () => {
    endFilePicker();
    if (folderFileInput.files) handleUploadedFiles(folderFileInput.files, true);
    folderFileInput.value = "";
  });
  // Safety net: if the user cancels the picker, the change event may not fire,
  // but the window regaining focus means the dialog is gone.
  window.addEventListener("focus", endFilePicker);

  const dialog = $("#meme-save-dialog") as HTMLDialogElement | null;
  $("#meme-save-confirm")?.addEventListener("click", (e) => {
    e.preventDefault();
    dialog?.close("save");
    doSave();
  });

  // Resize canvas wrapper on panel resize (best-effort).
  new ResizeObserver(() => scheduleRender()).observe(canvasWrap || document.body);

  // Drag text around on the canvas.
  const canvas = $("#meme-canvas") as HTMLCanvasElement | null;
  canvas?.addEventListener("pointerdown", onCanvasPointerDown);
  canvas?.addEventListener("pointermove", onCanvasPointerMove);
  canvas?.addEventListener("pointerup", onCanvasPointerUp);
  canvas?.addEventListener("pointercancel", onCanvasPointerUp);
  canvas?.addEventListener("pointerleave", onCanvasPointerUp);

  // Mount the React file tree into the thumbs pane.
  const thumbsEl = $("#meme-thumbs");
  if (thumbsEl && !treeRoot) {
    treeRoot = createRoot(thumbsEl);
  }

  // Mount the React layer table below the canvas.
  const layersEl = $("#meme-layers");
  if (layersEl && !layersRoot) {
    layersRoot = createRoot(layersEl);
  }
  renderLayers();
  renderThumbs();
}

async function loadFolder(raw: string) {
  const status = $("#meme-status");
  try {
    const listing: DirListing = await invoke("list_dir_meme", { path: raw });
    const next = listing.entries.filter(
      (e) => e.is_dir || IMAGE_EXTS.has(e.ext.toLowerCase()),
    );
    const keepCurrent = state.currentPath && next.some((e) => e.path === state.currentPath);
    state.folder = listing.path;
    try {
      localStorage.setItem(STORAGE_KEY, listing.path);
    } catch {
      // ignore localStorage failures
    }
    state.entries = next;
    if (status) status.textContent = `${state.entries.length} item${state.entries.length === 1 ? "" : "s"}`;
    renderThumbs();
    const firstImage = next.find((e) => !e.is_dir);
    if (firstImage && !keepCurrent) {
      await selectEntry(firstImage);
    }
    startFolderPoll(listing.path);
  } catch (e) {
    // If the user pasted a single image path, load it instead of a folder.
    if (IMAGE_EXTS.has(extOf(raw))) {
      try {
        await loadImageFile(raw);
        return;
      } catch (e2) {
        const msg = String(e2);
        const hint = /not permitted|permission denied/i.test(msg)
          ? " — use Upload files/folder instead"
          : "";
        if (status) status.textContent = msg + hint;
        stopFolderPoll();
        return;
      }
    }
    const msg = String(e);
    const hint = /not permitted|permission denied/i.test(msg)
      ? " — use Upload files/folder instead"
      : "";
    if (status) status.textContent = msg + hint;
    stopFolderPoll();
  }
}

async function loadImageFile(path: string) {
  const url = await invoke<string>("read_image", { path });
  if (!url) throw new Error("empty image data");
  const entry: FsEntry = {
    name: basename(path),
    path,
    is_dir: false,
    size: 0,
    modified: 0,
    ext: extOf(path),
  };
  state.entries = [entry];
  state.folder = await dirname(path).catch(() => "");
  state.currentPath = path;
  state.currentDataUrl = url;
  renderThumbs();
  await loadImage(url);
  renderThumbs();
  scheduleRender();
  setStatus(`loaded ${entry.name}`);
  if (state.folder) startFolderPoll(state.folder);
}

function startFolderPoll(path: string) {
  stopFolderPoll();
  folderPollTimer = window.setInterval(() => {
    if (state.folder === path && !pollInProgress) {
      pollInProgress = true;
      pollFolder(path).finally(() => {
        pollInProgress = false;
      });
    }
  }, 5000);
}

function stopFolderPoll() {
  if (folderPollTimer !== undefined) {
    clearInterval(folderPollTimer);
    folderPollTimer = undefined;
  }
}

async function pollFolder(path: string) {
  try {
    const listing: DirListing = await invoke("list_dir_meme", { path });
    const next = listing.entries.filter(
      (e) => e.is_dir || IMAGE_EXTS.has(e.ext.toLowerCase()),
    );
    const same =
      next.length === state.entries.length &&
      next.every((e, i) => e.path === state.entries[i]?.path);
    if (!same) {
      state.entries = next;
      renderThumbs();
      const status = $("#meme-status");
      if (status) status.textContent = `${next.length} item${next.length === 1 ? "" : "s"} (live)`;
    }
  } catch {
    // Folder may have been deleted or become unreachable; stop polling.
    stopFolderPoll();
  }
}

function renderThumbs() {
  if (!treeRoot) return;
  treeRoot.render(
    createElement(MemeTree, {
      rootPath: state.folder,
      rootEntries: state.entries,
      activePath: state.currentPath,
      onSelect: openMemeFile,
    }),
  );
}

async function selectEntry(e: FsEntry) {
  try {
    const url =
      uploadObjectUrls.get(e.path) ?? (await invoke<string>("read_image", { path: e.path }));
    if (!url) return;
    state.currentPath = e.path;
    state.currentDataUrl = url;
    await loadImage(url);
    renderThumbs();
    scheduleRender();
  } catch (err) {
    setStatus(String(err));
  }
}

export async function openMemeFile(path: string) {
  const entry: FsEntry = {
    name: basename(path),
    path,
    is_dir: false,
    size: 0,
    modified: 0,
    ext: extOf(path),
  };
  await selectEntry(entry);
}

function loadImage(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      state.image = img;
      state.naturalWidth = img.naturalWidth;
      state.naturalHeight = img.naturalHeight;
      resolve();
    };
    img.onerror = () => reject(new Error("failed to load image"));
    img.src = url;
  });
}

function capDimensions(w: number, h: number, max: number): { width: number; height: number } {
  if (!w || !h) return { width: w, height: h };
  if (w <= max && h <= max) return { width: w, height: h };
  const scale = Math.min(max / w, max / h);
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    renderCanvas();
  });
}

function renderCanvas() {
  const canvas = $("#meme-canvas") as HTMLCanvasElement | null;
  if (!canvas || !state.image) return;

  const wrap = $("#meme-canvas-wrap");
  const wrapW = wrap?.clientWidth || 640;
  const wrapH = wrap?.clientHeight || 480;

  // Cap the backing store so huge Retina screenshots don't freeze the renderer.
  // Visual scaling still happens via CSS, so the user sees the full image.
  const dims = capDimensions(state.naturalWidth, state.naturalHeight, MAX_CANVAS_DIM);
  canvas.width = dims.width || wrapW;
  canvas.height = dims.height || wrapH;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(state.image, 0, 0, canvas.width, canvas.height);

  const fontFamily = "Impact, Haettenschweiler, 'Arial Narrow Bold', sans-serif";
  ctx.textAlign = "center";
  ctx.lineJoin = "round";
  ctx.font = `bold 48px ${fontFamily}`;

  const boxes: ({ id: string } & TextBox)[] = [];

  for (const layer of state.layers) {
    if (!layer.text.trim()) continue;
    const size = layer.size || 48;
    const strokeWidth = layer.strokeWidth ?? 4;
    const fill = layer.fill || "#ffffff";
    const stroke = layer.stroke || "#000000";
    const caps = layer.caps ?? true;

    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = strokeWidth;

    const pad = size * 0.5;
    const maxW = canvas.width - pad * 2;

    const raw = caps ? layer.text.toUpperCase() : layer.text;
    const layout = layoutMemeText(ctx, raw, maxW, size);
    const vDir = layer.yPct <= 0.5 ? -1 : 1;
    const x = clamp(layer.xPct * canvas.width, size + strokeWidth, canvas.width - size - strokeWidth);
    const y = clamp(layer.yPct * canvas.height, size + strokeWidth, canvas.height - size - strokeWidth);
    drawMemeTextLayout(ctx, layout, x, y, vDir);
    boxes.push({ id: layer.id, ...measureTextBox(ctx, layout, x, y, vDir) });
  }

  state.textBoxes = boxes;
  fitCanvas(canvas, wrapW, wrapH);
}

function fitCanvas(canvas: HTMLCanvasElement, wrapW: number, wrapH: number) {
  const scale = Math.min(wrapW / canvas.width, wrapH / canvas.height, 1);
  canvas.style.width = `${canvas.width * scale}px`;
  canvas.style.height = `${canvas.height * scale}px`;
}

function canvasPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left) * (canvas.width / rect.width),
    y: (clientY - rect.top) * (canvas.height / rect.height),
  };
}

function hitTextBox(pt: { x: number; y: number }, box?: TextBox): boolean {
  if (!box) return false;
  return pt.x >= box.x && pt.x <= box.x + box.width && pt.y >= box.y && pt.y <= box.y + box.height;
}

function onCanvasPointerDown(e: PointerEvent) {
  const canvas = $("#meme-canvas") as HTMLCanvasElement | null;
  if (!canvas || !state.textBoxes) return;
  const pt = canvasPoint(canvas, e.clientX, e.clientY);
  for (const box of state.textBoxes) {
    if (hitTextBox(pt, box)) {
      state.dragLayerId = box.id;
      state.activeLayerId = box.id;
      renderLayers();
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
  }
}

function onCanvasPointerMove(e: PointerEvent) {
  const canvas = $("#meme-canvas") as HTMLCanvasElement | null;
  if (!canvas) return;
  const pt = canvasPoint(canvas, e.clientX, e.clientY);
  if (state.dragLayerId) {
    const layer = state.layers.find((l) => l.id === state.dragLayerId);
    if (layer) {
      layer.xPct = clamp(pt.x / canvas.width, 0.02, 0.98);
      layer.yPct = clamp(pt.y / canvas.height, 0.02, 0.98);
    }
    scheduleRender();
    renderLayers();
    return;
  }
  const hovering = state.textBoxes?.some((box) => hitTextBox(pt, box)) ?? false;
  canvas.style.cursor = hovering ? "move" : "";
}

function onCanvasPointerUp(e: PointerEvent) {
  const canvas = $("#meme-canvas") as HTMLCanvasElement | null;
  if (canvas && state.dragLayerId) {
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      // capture may already be released
    }
    saveMemeState();
  }
  state.dragLayerId = null;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

interface TextLayout {
  lines: string[];
  size: number;
}

function layoutMemeText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
  baseSize: number,
): TextLayout {
  ctx.font = ctx.font.replace(/\d+px/, `${baseSize}px`);
  const lines = wrapLines(ctx, text, maxW);
  let size = baseSize;
  while (size > 12 && lines.some((l) => ctx.measureText(l).width > maxW)) {
    size -= 2;
    ctx.font = ctx.font.replace(/\d+px/, `${size}px`);
  }
  return { lines, size };
}

function drawMemeTextLayout(
  ctx: CanvasRenderingContext2D,
  layout: TextLayout,
  x: number,
  y: number,
  vDir: -1 | 1,
) {
  ctx.font = ctx.font.replace(/\d+px/, `${layout.size}px`);
  const lineH = layout.size * 1.2;
  for (let i = 0; i < layout.lines.length; i++) {
    const line = layout.lines[i];
    const offset = vDir < 0 ? i * lineH : -(layout.lines.length - 1 - i) * lineH;
    ctx.strokeText(line, x, y + offset);
    ctx.fillText(line, x, y + offset);
  }
}

function measureTextBox(
  ctx: CanvasRenderingContext2D,
  layout: TextLayout,
  x: number,
  y: number,
  vDir: -1 | 1,
): TextBox {
  const { lines, size } = layout;
  const lineH = size * 1.2;
  const maxLineW = Math.max(0, ...lines.map((l) => ctx.measureText(l).width));
  const halfW = maxLineW / 2;
  const top = vDir < 0 ? y - size : y - (lines.length - 1) * lineH - size;
  const bottom = vDir < 0 ? y + (lines.length - 1) * lineH + size * 0.2 : y + size * 0.2;
  return {
    x: x - halfW,
    y: top,
    width: maxLineW,
    height: bottom - top,
  };
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const hardLines = text.split("\n");
  const out: string[] = [];
  for (const line of hardLines) {
    const words = line.split(/\s+/).filter(Boolean);
    if (!words.length) {
      out.push("");
      continue;
    }
    let current = words[0];
    for (const w of words.slice(1)) {
      const test = `${current} ${w}`;
      if (ctx.measureText(test).width <= maxW) {
        current = test;
      } else {
        out.push(current);
        current = w;
      }
    }
    out.push(current);
  }
  return out;
}

async function copyMeme() {
  const canvas = $("#meme-canvas") as HTMLCanvasElement | null;
  if (!canvas) return;
  try {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!blob) throw new Error("canvas empty");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    setStatus("copied to clipboard");
  } catch (e) {
    setStatus(`copy failed: ${e}`);
  }
}

function showSaveDialog() {
  const dialog = $("#meme-save-dialog") as HTMLDialogElement | null;
  const pathInput = $("#meme-save-path") as HTMLInputElement | null;
  if (!dialog || !pathInput) return;

  let base: string;
  if (state.currentPath.startsWith("upload://")) {
    const name = state.currentPath.slice(9).replace(/\.[^.]+$/, "-meme.png");
    base = state.folder ? `${state.folder}/${name}` : `${homeDirFallback()}/${name}`;
  } else if (state.currentPath) {
    base = state.currentPath.replace(/\.[^.]+$/, "-meme.png");
  } else if (state.folder) {
    base = `${state.folder}/meme.png`;
  } else {
    base = `${homeDirFallback()}/meme.png`;
  }
  pathInput.value = base;
  dialog.showModal();
}

function homeDirFallback(): string {
  // Best-effort; the save dialog lets the user edit the path anyway.
  return state.folder || homeDirResolved || "/Users";
}

function deriveOutputPath(suffix: string): string {
  const name = state.currentPath.startsWith("upload://")
    ? state.currentPath.slice(9).replace(/\.[^.]+$/, "")
    : state.currentPath.replace(/\.[^.]+$/, "");
  const file = `${basename(name)}${suffix}`;
  if (state.currentPath.startsWith("upload://")) {
    return state.folder ? `${state.folder}/${file}` : `${homeDirFallback()}/${file}`;
  }
  const dir = state.currentPath.split("/").slice(0, -1).join("/");
  return dir ? `${dir}/${file}` : file;
}

async function doSave() {
  const pathInput = $("#meme-save-path") as HTMLInputElement | null;
  const canvas = $("#meme-canvas") as HTMLCanvasElement | null;
  if (!pathInput || !canvas) return;
  const path = pathInput.value.trim();
  if (!path) return;
  try {
    const dataUrl = canvas.toDataURL("image/png");
    await invoke("save_meme", { path, dataUrl });
    setStatus(`saved ${path}`);
  } catch (e) {
    setStatus(`save failed: ${e}`);
  }
}

async function makeSlackEmoji() {
  const canvas = $("#meme-canvas") as HTMLCanvasElement | null;
  if (!canvas) return;
  if (!state.currentPath) {
    setStatus("load or create an image first");
    return;
  }

  // Export the current canvas to a temp file, then ask ImageMagick to make it
  // Slack-compatible. We use the source folder as the output parent.
  const outPath = deriveOutputPath("-slack-emoji.png");
  try {
    const dataUrl = canvas.toDataURL("image/png");
    await invoke("save_meme", { path: outPath, dataUrl });
    const res = await invoke<{ ok: boolean; stderr: string; command: string }>("make_slack_emoji", {
      input: outPath,
      output: outPath,
    });
    if ((res as any).ok) {
      setStatus(`slack emoji ${outPath}`);
    } else {
      setStatus(`emoji failed: ${(res as any).stderr || (res as any).command}`);
    }
  } catch (e) {
    setStatus(`emoji failed: ${e}`);
  }
}

function setStatus(msg: string) {
  const el = $("#meme-status");
  if (el) el.textContent = msg;
}

function saveMemeState() {
  try {
    localStorage.setItem(
      MEME_STATE_KEY,
      JSON.stringify({
        layers: state.layers,
        activeLayerId: state.activeLayerId,
      }),
    );
  } catch {
    // localStorage may be disabled or full; ignore.
  }
}

function loadMemeState() {
  try {
    const raw = localStorage.getItem(MEME_STATE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as {
      layers?: TextLayer[];
      activeLayerId?: string;
      top?: string;
      bottom?: string;
      size?: string | number;
      fill?: string;
      stroke?: string;
      strokeWidth?: string | number;
      caps?: boolean;
      textTopPct?: number;
      textBottomPct?: number;
    };
    if (saved.layers?.length) {
      state.layers = saved.layers.map((l) => ({ ...DEFAULT_LAYERS[0], ...l }));
      state.activeLayerId = saved.activeLayerId ?? state.layers[0].id;
    } else {
      // Migrate the old flat top/bottom state into two layers.
      const size = Number(saved.size) || 48;
      const fill = saved.fill ?? "#ffffff";
      const stroke = saved.stroke ?? "#000000";
      const strokeWidth = Number(saved.strokeWidth) || 4;
      const caps = saved.caps ?? true;
      state.layers = [
        {
          ...DEFAULT_LAYERS[0],
          text: saved.top ?? "",
          size,
          fill,
          stroke,
          strokeWidth,
          caps,
          yPct: saved.textTopPct ?? 0.08,
        },
        {
          ...DEFAULT_LAYERS[1],
          text: saved.bottom ?? "",
          size,
          fill,
          stroke,
          strokeWidth,
          caps,
          yPct: saved.textBottomPct ?? 0.92,
        },
      ];
      state.activeLayerId = state.layers[0].id;
    }
    scheduleRender();
  } catch {
    // ignore corrupt/missing storage
  }
}

function renderLayers() {
  if (!layersRoot) return;
  layersRoot.render(
    createElement(MemeLayers, {
      layers: state.layers,
      activeLayerId: state.activeLayerId,
      onChange: (layers) => {
        state.layers = layers;
        if (!layers.some((l) => l.id === state.activeLayerId)) {
          state.activeLayerId = layers[0]?.id ?? "";
        }
        scheduleRender();
        saveMemeState();
        renderLayers();
      },
      onActivate: (id) => {
        state.activeLayerId = id;
        renderLayers();
      },
    }),
  );
}

async function handleUploadedFiles(files: FileList, fromFolder = false) {
  stopFolderPoll();
  // Revoke old object URLs so we don't leak memory on repeat uploads.
  for (const url of uploadObjectUrls.values()) {
    URL.revokeObjectURL(url);
  }
  uploadObjectUrls.clear();

  const entries: FsEntry[] = [];
  for (const file of Array.from(files)) {
    const ext = extOf(file.name);
    if (!IMAGE_EXTS.has(ext)) continue;
    const objectUrl = URL.createObjectURL(file);
    const syntheticPath = `upload://${file.name}`;
    uploadObjectUrls.set(syntheticPath, objectUrl);
    entries.push({
      name: file.name,
      path: syntheticPath,
      is_dir: false,
      size: file.size,
      modified: file.lastModified,
      ext,
    });
  }
  if (!entries.length) {
    setStatus("no supported images selected");
    return;
  }

  // When uploading a folder, try to set the logical folder from webkitRelativePath.
  if (fromFolder && files[0]?.webkitRelativePath) {
    const first = files[0].webkitRelativePath;
    const slash = first.indexOf("/");
    state.folder = slash > 0 ? `upload://folder/${first.slice(0, slash)}` : "";
  }

  state.entries = entries;
  renderThumbs();
  await selectEntry(entries[0]);
  setStatus(`${entries.length} uploaded`);
}

// Public entry used by main.ts when files/folders are dropped onto the panel.
export async function handleMemeDrop(paths: string[]) {
  const imagePaths = paths.filter((p) => IMAGE_EXTS.has(extOf(p)));
  const folders = paths.filter((p) => !extOf(p));

  if (imagePaths.length === 1 && !folders.length) {
    // Single image: load it directly even if folder is unknown.
    await loadImageFile(imagePaths[0]);
    return;
  }

  if (folders.length) {
    const folderInput = $("#meme-folder") as HTMLInputElement | null;
    if (folderInput) folderInput.value = folders[0];
    await loadFolder(folders[0]);
  }

  if (imagePaths.length > 1 && !folders.length) {
    // Multiple images dropped from different folders: show them all.
    state.entries = imagePaths.map((p) => ({
      name: basename(p),
      path: p,
      is_dir: false,
      size: 0,
      modified: 0,
      ext: extOf(p),
    }));
    renderThumbs();
    if (state.entries.length) await selectEntry(state.entries[0]);
  }
}

function extOf(path: string): string {
  const i = path.lastIndexOf(".");
  return i > 0 ? path.slice(i + 1).toLowerCase() : "";
}

function basename(path: string): string {
  return path.split(/[\/]/).pop() || path;
}
