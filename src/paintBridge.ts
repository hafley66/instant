// Bridge between the Paint panel and the vendored miniPaint iframe. The iframe
// is same-origin (served from /vendor/miniPaint), so the parent reaches its
// window directly — miniPaint registers window.Layers / AppConfig / State /
// FileOpen on load (see src/js/main.js in the vendored app).
//
// Dirty tracking: every mutating edit in miniPaint goes through
// State.do_action (the undo entry point), so the bridge wraps it — open_file*
// actions are clean points (a fresh load), selection actions don't count,
// anything else is an unsaved edit.
import { paintJsonToSvg } from "./0_paintSvg";

interface MiniPaintAction {
  action_id?: string;
}

const SVG_SOURCE_SLOT = "paint_svg_source";

// The miniPaint globals, typed structurally (the vendored app ships no types).
interface MiniPaintWindow {
  Layers?: {
    convert_layers_to_canvas(
      ctx: CanvasRenderingContext2D,
      layerId: string | null,
      isPreview: boolean,
    ): void;
  };
  AppConfig?: { WIDTH: number; HEIGHT: number };
  State?: {
    do_action(action: MiniPaintAction, ...rest: unknown[]): unknown;
  };
  FileOpen?: {
    file_open_data_url_handler(data: string): void;
    load_json(data: string): Promise<unknown>;
  };
  FileSave?: {
    export_as_json(): string;
  };
}

export interface PaintBridge {
  // Open an image data URL as a new document (replaces the canvas contents).
  loadDataUrl(dataUrl: string): void;
  // Open SVG through miniPaint while retaining the original XML for SVG export.
  loadSvgText(svg: string): void;
  // Flatten all layers to a PNG data URL (same recipe as miniPaint's File>Save).
  compositePng(): string | null;
  exportSvg(): string | null;
  clearSvgSource(): void;
  // Session snapshot (miniPaint's quicksave/quickload mechanism): full layers
  // JSON in the shared localStorage slot "quicksave_data". Survives reloads;
  // capped at 5 MB like miniPaint's own F9 quicksave.
  quicksave(): boolean;
  quickload(): boolean;
  hasQuicksave(): boolean;
  clearQuicksave(): void;
  destroy(): void;
}

export interface PaintBridgeHooks {
  onEdit: () => void; // a mutating edit happened since the last clean point
  onClean: () => void; // a fresh document was loaded inside the editor
}

export function installPaintBridge(
  iframe: HTMLIFrameElement,
  hooks: PaintBridgeHooks,
): PaintBridge | null {
  const w = iframe.contentWindow as (Window & MiniPaintWindow) | null;
  if (!w?.Layers || !w.AppConfig || !w.State || !w.FileOpen) return null;
  const { Layers, AppConfig, State, FileOpen } = w as Required<MiniPaintWindow>;

  const origDoAction = State.do_action.bind(State);
  let svgSource = localStorage.getItem(SVG_SOURCE_SLOT);
  State.do_action = (action: MiniPaintAction, ...rest: unknown[]) => {
    const id = String(action?.action_id ?? "");
    const result = origDoAction(action, ...rest);
    if (id.startsWith("open_file") || id.startsWith("open_image") || id.startsWith("quickload")) hooks.onClean();
    else if (!/select|selection/i.test(id)) {
      svgSource = null;
      localStorage.removeItem(SVG_SOURCE_SLOT);
      hooks.onEdit();
    }
    return result;
  };

  return {
    loadDataUrl(dataUrl) {
      svgSource = null;
      localStorage.removeItem(SVG_SOURCE_SLOT);
      FileOpen.file_open_data_url_handler(dataUrl);
    },
    loadSvgText(svg) {
      svgSource = svg;
      localStorage.setItem(SVG_SOURCE_SLOT, svg);
      const metadata = new DOMParser()
        .parseFromString(svg, "image/svg+xml")
        .querySelector("metadata#instant-paint-document")
        ?.textContent;
      if (metadata) {
        try {
          const documentData = JSON.parse(metadata);
          if (Array.isArray(documentData.layers)) {
            void FileOpen.load_json(metadata);
            return;
          }
        } catch {
          // Fall through to the normal SVG image loader.
        }
      }
      FileOpen.file_open_data_url_handler(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    },
    compositePng() {
      try {
        const canvas = iframe.contentDocument!.createElement("canvas");
        canvas.width = AppConfig.WIDTH;
        canvas.height = AppConfig.HEIGHT;
        const ctx = canvas.getContext("2d");
        if (!ctx || !canvas.width || !canvas.height) return null;
        Layers.convert_layers_to_canvas(ctx, null, false);
        return canvas.toDataURL("image/png");
      } catch {
        return null;
      }
    },
    exportSvg() {
      const fileSave = w.FileSave;
      if (svgSource) return svgSource;
      return fileSave ? paintJsonToSvg(fileSave.export_as_json(), this.compositePng()) : null;
    },
    clearSvgSource() {
      svgSource = null;
      localStorage.removeItem(SVG_SOURCE_SLOT);
    },
    quicksave() {
      try {
        const fileSave = w.FileSave;
        if (!fileSave) return false;
        const data = fileSave.export_as_json();
        if (data.length > 5_000_000) return false;
        localStorage.setItem("quicksave_data", data);
        return true;
      } catch {
        return false;
      }
    },
    quickload() {
      const data = localStorage.getItem("quicksave_data");
      if (!data) return false;
      void FileOpen.load_json(data);
      return true;
    },
    hasQuicksave() {
      return !!localStorage.getItem("quicksave_data");
    },
    clearQuicksave() {
      localStorage.removeItem("quicksave_data");
      localStorage.removeItem(SVG_SOURCE_SLOT);
      svgSource = null;
    },
    destroy() {
      State.do_action = origDoAction;
    },
  };
}

// The live bridge (one paint panel at a time — it's a singleton tool panel).
// paintSessions drives loads/saves without owning the iframe.
let active: PaintBridge | null = null;
export function setActivePaintBridge(b: PaintBridge | null): void {
  active = b;
}
export function activePaintBridge(): PaintBridge | null {
  return active;
}
