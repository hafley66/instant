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
import { readPluginState, savePluginState } from "./pluginState";
import { flashStatus, getHomeDir, showError, tildify } from "./core";
import { defaultExportPath, deriveOutputPath, writeMemePng, copyMemePng } from "./memeExport";

const STORAGE_KEY = "meme:lastFolder";
const MEME_STATE_KEY = "meme:state";
const PLUGIN_ID = "meme";
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
  dragMode: "move" | "resize" | null;
  resizeStart: { size: number; dist: number; cx: number; cy: number } | null;
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
  dragMode: null,
  resizeStart: null,
  textBoxes: null,
};

// Object URLs for files uploaded via the HTML file picker. The key is the
// synthetic `upload://<name>` path used in state.entries.
const uploadObjectUrls = new Map<string, string>();

// Cap the canvas backing store so Retina screenshots don't freeze the renderer.
const MAX_CANVAS_DIM = 1920;

let renderPending = false;
let folderPollTimer: number | undefined;
let pollInProgress = false;
let treeRoot: Root | null = null;
let layersRoot: Root | null = null;
// Used only to restore the last-opened folder on mount; the Export/Save
// defaults use core.ts's app-wide getHomeDir() instead (set once at boot).
let lastFolderPromise: Promise<string> = homeDir().catch(() => "");

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
  return readPluginState<MemeUi>(PLUGIN_ID, {});
}

function saveMemeUi(patch: Partial<MemeUi>) {
  savePluginState<MemeUi>(PLUGIN_ID, patch);
}

function MemePanel() {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const thumbsRef = useRef<HTMLDivElement>(null);
  const layersRef = useRef<HTMLDivElement>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const [ui, setUi] = useState<MemeUi>(() => readMemeUi());

  useEffect(() => {
    const cleanup = wireMemePanel();
    return cleanup;
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
        <button id="meme-export" type="button" title="Save to ~/Desktop, no path needed">Export PNG</button>
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
          <canvas id="meme-overlay"></canvas>
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

function wireMemePanel(): () => void {
  const form = $("#meme-folder-form");
  const folderInput = $("#meme-folder") as HTMLInputElement | null;
  const canvasWrap = $("#meme-canvas-wrap");
  const canvas = $("#meme-canvas") as HTMLCanvasElement | null;
  const dialog = $("#meme-save-dialog") as HTMLDialogElement | null;

  // Re-mount React roots on every mount so they always point to the current DOM nodes
  // (the panel can be unmounted/remounted by dockview or React StrictMode).
  treeRoot?.unmount();
  layersRoot?.unmount();
  treeRoot = null;
  layersRoot = null;

  const thumbsEl = $("#meme-thumbs");
  const layersEl = $("#meme-layers");
  if (thumbsEl) treeRoot = createRoot(thumbsEl);
  if (layersEl) layersRoot = createRoot(layersEl);

  const listeners: { el: EventTarget; type: string; fn: EventListener }[] = [];
  function on<T extends Event>(el: EventTarget | null, type: string, fn: (e: T) => void) {
    if (!el) return;
    const listener = (e: Event) => fn(e as T);
    el.addEventListener(type, listener);
    listeners.push({ el, type, fn: listener });
  }

  on(form, "submit", async (e: Event) => {
    e.preventDefault();
    const path = folderInput?.value.trim();
    if (path) await loadFolder(path);
  });

  on($("#meme-export"), "click", () => exportMemeOneClick());
  on($("#meme-copy"), "click", () => copyMeme());
  on($("#meme-save"), "click", () => showSaveDialog());
  on($("#meme-emoji"), "click", () => makeSlackEmoji());

  const fileInput = $("#meme-file-input") as HTMLInputElement | null;
  const folderFileInput = $("#meme-folder-input") as HTMLInputElement | null;

  function openFilePicker(input: HTMLInputElement) {
    setFilePickerOpen(true);
    input.click();
  }
  function endFilePicker() {
    setFilePickerOpen(false);
  }

  on($("#meme-upload-files"), "click", () => fileInput && openFilePicker(fileInput));
  on($("#meme-upload-folder"), "click", () => folderFileInput && openFilePicker(folderFileInput));
  on(fileInput, "change", () => {
    if (!fileInput) return;
    endFilePicker();
    if (fileInput.files) handleUploadedFiles(fileInput.files);
    fileInput.value = "";
  });
  on(folderFileInput, "change", () => {
    if (!folderFileInput) return;
    endFilePicker();
    if (folderFileInput.files) handleUploadedFiles(folderFileInput.files, true);
    folderFileInput.value = "";
  });
  // Safety net: if the user cancels the picker, the change event may not fire,
  // but the window regaining focus means the dialog is gone.
  on(window, "focus", endFilePicker);

  on($("#meme-save-confirm"), "click", (e: Event) => {
    e.preventDefault();
    dialog?.close("save");
    doSave();
  });

  // Drag text around on the canvas.
  on(canvas, "pointerdown", onCanvasPointerDown);
  on(canvas, "pointermove", onCanvasPointerMove);
  on(canvas, "pointerup", onCanvasPointerUp);
  on(canvas, "pointercancel", onCanvasPointerUp);
  on(canvas, "pointerleave", onCanvasPointerUp);

  // Resize canvas wrapper on panel resize (best-effort).
  const ro = new ResizeObserver(() => scheduleRender());
  ro.observe(canvasWrap || document.body);

  loadMemeState();

  // Restore last folder.
  lastFolderPromise.then(async (home) => {
    const saved = localStorage.getItem(STORAGE_KEY);
    const initial = saved || home || "";
    if (folderInput) folderInput.value = initial;
    if (initial) await loadFolder(initial);
  });

  renderLayers();
  renderThumbs();

  return () => {
    for (const { el, type, fn } of listeners) {
      el.removeEventListener(type, fn);
    }
    ro.disconnect();
    treeRoot?.unmount();
    layersRoot?.unmount();
    treeRoot = null;
    layersRoot = null;
  };
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
  renderOverlay();
}

// Selection overlay for the active text layer: dashed outline + 4 corner handles.
// Drawn on a separate canvas (#meme-overlay) stacked over #meme-canvas so Copy /
// Save exports never include it. Handles are visual only — hit-testing uses the
// same box coordinates on the main canvas's pointer events.
function handleSize(canvas: HTMLCanvasElement) {
  return Math.max(10, canvas.width / 90);
}
function boxCorners(box: TextBox) {
  return [
    [box.x, box.y],
    [box.x + box.width, box.y],
    [box.x, box.y + box.height],
    [box.x + box.width, box.y + box.height],
  ] as const;
}
function handleAt(
  pt: { x: number; y: number },
  box: TextBox,
  h: number,
): boolean {
  return boxCorners(box).some(
    ([hx, hy]) => Math.abs(pt.x - hx) <= h && Math.abs(pt.y - hy) <= h,
  );
}
function renderOverlay() {
  const canvas = $("#meme-canvas") as HTMLCanvasElement | null;
  const overlay = $("#meme-overlay") as HTMLCanvasElement | null;
  if (!canvas || !overlay) return;
  // Mirror the canvas exactly: backing store (drawing coords) + CSS box (layout).
  overlay.width = canvas.width;
  overlay.height = canvas.height;
  overlay.style.width = canvas.style.width;
  overlay.style.height = canvas.style.height;
  const ctx = overlay.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  const box = state.textBoxes?.find((b) => b.id === state.activeLayerId);
  if (!box) return;
  const h = handleSize(canvas);
  ctx.lineWidth = Math.max(1, canvas.width / 700);
  ctx.strokeStyle = "rgba(90,165,255,0.95)";
  ctx.fillStyle = "#fff";
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(box.x, box.y, box.width, box.height);
  ctx.setLineDash([]);
  for (const [hx, hy] of boxCorners(box)) {
    ctx.fillRect(hx - h / 2, hy - h / 2, h, h);
    ctx.strokeRect(hx - h / 2, hy - h / 2, h, h);
  }
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
  const h = handleSize(canvas);
  // Resize handles on the active box take priority over a new move grab.
  const active = state.textBoxes.find((b) => b.id === state.activeLayerId);
  if (active && handleAt(pt, active, h)) {
    const layer = state.layers.find((l) => l.id === active.id);
    const cx = active.x + active.width / 2;
    const cy = active.y + active.height / 2;
    state.dragLayerId = active.id;
    state.dragMode = "resize";
    state.resizeStart = {
      size: layer?.size ?? 48,
      dist: Math.max(1, Math.hypot(pt.x - cx, pt.y - cy)),
      cx,
      cy,
    };
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }
  for (const box of state.textBoxes) {
    if (hitTextBox(pt, box)) {
      state.dragLayerId = box.id;
      state.activeLayerId = box.id;
      state.dragMode = "move";
      renderLayers();
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
  }
  // Empty space: deselect, hiding the outline + handles.
  if (state.activeLayerId) {
    state.activeLayerId = "";
    renderLayers();
    renderOverlay();
  }
}

function onCanvasPointerMove(e: PointerEvent) {
  const canvas = $("#meme-canvas") as HTMLCanvasElement | null;
  if (!canvas) return;
  const pt = canvasPoint(canvas, e.clientX, e.clientY);
  if (state.dragLayerId && state.dragMode === "resize" && state.resizeStart) {
    const layer = state.layers.find((l) => l.id === state.dragLayerId);
    if (layer) {
      const { size, dist, cx, cy } = state.resizeStart;
      const ratio = Math.hypot(pt.x - cx, pt.y - cy) / dist;
      layer.size = Math.round(clamp(size * ratio, 12, 256));
    }
    scheduleRender();
    renderLayers();
    return;
  }
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
  // Hover cursor: resize handle > move > default.
  const h = handleSize(canvas);
  const active = state.textBoxes?.find((b) => b.id === state.activeLayerId);
  if (active && handleAt(pt, active, h)) canvas.style.cursor = "nwse-resize";
  else if (state.textBoxes?.some((box) => hitTextBox(pt, box))) canvas.style.cursor = "move";
  else canvas.style.cursor = "";
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
  state.dragMode = null;
  state.resizeStart = null;
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

// One-click export: no dialog, no path to type. Writes straight to
// ~/Desktop/meme-<timestamp>.png (parent dir + `~` handled on the Rust side
// too, but this is already an absolute path) and flashes the written path.
async function exportMemeOneClick() {
  const canvas = $("#meme-canvas") as HTMLCanvasElement | null;
  if (!canvas || !state.image) {
    setStatus("load or create an image first");
    return;
  }
  const path = defaultExportPath(getHomeDir());
  try {
    const dataUrl = canvas.toDataURL("image/png");
    await writeMemePng(path, dataUrl);
    flashStatus(`saved ${tildify(path)}`);
    setStatus(`saved ${tildify(path)}`);
  } catch (e) {
    showError("meme-export", e);
    setStatus(`export failed: ${e}`);
  }
}

async function copyMeme() {
  const canvas = $("#meme-canvas") as HTMLCanvasElement | null;
  if (!canvas) return;
  try {
    const dataUrl = canvas.toDataURL("image/png");
    await copyMemePng(dataUrl);
    setStatus("copied to clipboard");
  } catch (e) {
    showError("meme-copy", e);
    setStatus(`copy failed: ${e}`);
  }
}

function showSaveDialog() {
  const dialog = $("#meme-save-dialog") as HTMLDialogElement | null;
  const pathInput = $("#meme-save-path") as HTMLInputElement | null;
  if (!dialog || !pathInput) return;
  // Prefill with the same default the one-click Export button writes to, so
  // this dialog is only ever needed to pick a *different* path.
  pathInput.value = defaultExportPath(getHomeDir());
  dialog.showModal();
}

async function doSave() {
  const pathInput = $("#meme-save-path") as HTMLInputElement | null;
  const canvas = $("#meme-canvas") as HTMLCanvasElement | null;
  if (!pathInput || !canvas) return;
  const path = pathInput.value.trim();
  if (!path) return;
  try {
    const dataUrl = canvas.toDataURL("image/png");
    await writeMemePng(path, dataUrl);
    flashStatus(`saved ${tildify(path)}`);
    setStatus(`saved ${path}`);
  } catch (e) {
    showError("meme-save", e);
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
  const outPath = deriveOutputPath(state.currentPath, state.folder, getHomeDir(), "-slack-emoji.png");
  try {
    const dataUrl = canvas.toDataURL("image/png");
    await writeMemePng(outPath, dataUrl);
    const res = await invoke<{ ok: boolean; stderr: string; command: string }>("make_slack_emoji", {
      input: outPath,
      output: outPath,
    });
    if (res.ok) {
      setStatus(`slack emoji ${outPath}`);
    } else {
      setStatus(`emoji failed: ${res.stderr || res.command}`);
    }
  } catch (e) {
    showError("meme-emoji", e);
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
        renderOverlay();
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
