// Bridge between the Paint panel and the vendored miniPaint iframe. The iframe
// is same-origin (served from /vendor/miniPaint), so the parent reaches its
// window directly — miniPaint registers window.Layers / AppConfig / State /
// FileOpen on load (see src/js/main.js in the vendored app).
//
// Dirty tracking: every mutating edit in miniPaint goes through
// State.do_action (the undo entry point), so the bridge wraps it — open_file*
// actions are clean points (a fresh load), selection actions don't count,
// anything else is an unsaved edit.

interface MiniPaintAction {
  action_id?: string;
}

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
  };
}

export interface PaintBridge {
  // Open an image data URL as a new document (replaces the canvas contents).
  loadDataUrl(dataUrl: string): void;
  // Flatten all layers to a PNG data URL (same recipe as miniPaint's File>Save).
  compositePng(): string | null;
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
  State.do_action = (action: MiniPaintAction, ...rest: unknown[]) => {
    const id = String(action?.action_id ?? "");
    const result = origDoAction(action, ...rest);
    if (id.startsWith("open_file") || id.startsWith("quickload")) hooks.onClean();
    else if (!/select|selection/i.test(id)) hooks.onEdit();
    return result;
  };

  return {
    loadDataUrl(dataUrl) {
      FileOpen.file_open_data_url_handler(dataUrl);
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
