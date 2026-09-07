import { invoke } from "../generated/native";
import { homeDir as tauriHomeDir } from "@tauri-apps/api/path";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview, type DragDropEvent } from "@tauri-apps/api/webview";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emit as tauriEmit } from "@tauri-apps/api/event";
import {
  openPath as tauriOpenPath,
  openUrl as tauriOpenUrl,
  revealItemInDir as tauriRevealItemInDir,
} from "@tauri-apps/plugin-opener";
import type { StatusLink, StatusState } from "../plugin";
import { hasTauriInternals, pickTransport, type NativeTransport } from "./nativeTransport";

// Logged through the command table, not core's logLine: core pulls state.ts,
// which reads `location` at module load and breaks the node test env.
const portLog = (line: string): void => {
  let stamp = "";
  try {
    stamp = new Date().toISOString();
  } catch {
    /* ignore */
  }
  invoke("log_append", { line: `${stamp} ${line}` }).catch(() => {});
};

// A second webview window addressed by label (the dropcatcher), in physical px
// so it covers the main window pixel for pixel.
export interface AuxWindow {
  show(): Promise<void>;
  hide(): Promise<void>;
  setPosition(x: number, y: number): Promise<void>;
  setSize(width: number, height: number): Promise<void>;
}

// Every direct @tauri-apps/* call in the app funnels through this object.
// window setSize/setPosition = logical px; outer*/AuxWindow ops = physical px.
export interface RuntimePorts {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  abortSignal(ms: number): AbortSignal;
  open(link: StatusLink): Promise<void>;
  setRailHealth(state: StatusState): void;
  openPath(path: string): Promise<void>;
  revealItemInDir(path: string): Promise<void>;
  openUrl(url: string): Promise<void>;
  homeDir(): Promise<string>;
  emit(event: string, payload?: unknown): Promise<void>;
  findWindow(label: string): Promise<AuxWindow | null>;
  window: {
    hide(): Promise<void>;
    show(): Promise<void>;
    minimize(): Promise<void>;
    toggleMaximize(): Promise<void>;
    startDragging(): Promise<void>;
    setFocus(): Promise<void>;
    setIgnoreCursorEvents(ignore: boolean): Promise<void>;
    setVisibleOnAllWorkspaces(all: boolean): Promise<void>;
    setSize(width: number, height: number): Promise<void>;
    setPosition(x: number, y: number): Promise<void>;
    scaleFactor(): Promise<number>;
    outerPosition(): Promise<{ x: number; y: number }>;
    outerSize(): Promise<{ width: number; height: number }>;
    onFocusChanged(cb: (focused: boolean) => void): Promise<() => void>;
  };
  webview: {
    setZoom(zoom: number): Promise<void>;
    onDragDrop(cb: (e: DragDropEvent) => void): Promise<() => void>;
  };
}

function setRailHealth(state: StatusState): void {
  const button = document.getElementById("status-toggle");
  if (button) button.dataset.health = state;
}

export function tauriPorts(): RuntimePorts {
  const win = () => getCurrentWindow();
  return {
    invoke,
    abortSignal: (ms) => AbortSignal.timeout(ms),
    open: (link) => (link.reveal ? tauriRevealItemInDir(link.path) : tauriOpenPath(link.path)),
    setRailHealth,
    openPath: (path) => tauriOpenPath(path),
    revealItemInDir: (path) => tauriRevealItemInDir(path),
    openUrl: (url) => tauriOpenUrl(url),
    homeDir: () => tauriHomeDir(),
    emit: (event, payload) => tauriEmit(event, payload),
    findWindow: async (label) => {
      const w = await WebviewWindow.getByLabel(label);
      return (
        w && {
          show: () => w.show(),
          hide: () => w.hide(),
          setPosition: (x, y) => w.setPosition(new PhysicalPosition(x, y)),
          setSize: (width, height) => w.setSize(new PhysicalSize(width, height)),
        }
      );
    },
    window: {
      hide: () => win().hide(),
      show: () => win().show(),
      minimize: () => win().minimize(),
      toggleMaximize: () => win().toggleMaximize(),
      startDragging: () => win().startDragging(),
      setFocus: () => win().setFocus(),
      setIgnoreCursorEvents: (ignore) => win().setIgnoreCursorEvents(ignore),
      setVisibleOnAllWorkspaces: (all) => win().setVisibleOnAllWorkspaces(all),
      setSize: (width, height) => win().setSize(new LogicalSize(width, height)),
      setPosition: (x, y) => win().setPosition(new LogicalPosition(x, y)),
      scaleFactor: () => win().scaleFactor(),
      outerPosition: async () => {
        const p = await win().outerPosition();
        return { x: p.x, y: p.y };
      },
      outerSize: async () => {
        const s = await win().outerSize();
        return { width: s.width, height: s.height };
      },
      onFocusChanged: (cb) => win().onFocusChanged(({ payload }) => cb(payload)),
    },
    webview: {
      setZoom: (zoom) => getCurrentWebview().setZoom(zoom),
      onDragDrop: (cb) => getCurrentWebview().onDragDropEvent((e) => cb(e.payload)),
    },
  };
}

// Backend commands the browser ports may call once they exist in
// ipc/commands.json; add a name here and the browser build uses it.
const openCommands = {
  // openPath: "open_external",
} as Partial<Record<"openPath" | "revealItemInDir" | "openUrl", string>>;

// Window/opener calls have no native edge in a plain browser: they resolve
// after one logLine so callers keep their promise semantics there.
export function browserPorts(transport: NativeTransport): RuntimePorts {
  const logged = (op: string) => async (): Promise<void> => {
    portLog(`ports: ${op} has no browser implementation`);
  };
  const openVia =
    (key: keyof typeof openCommands, op: string) =>
    async (target: string): Promise<void> => {
      const command = openCommands[key];
      if (command) {
        await transport.invoke(command, { path: target });
        return;
      }
      portLog(`ports: ${op} ${JSON.stringify(target)} ignored outside tauri`);
    };
  const ports: RuntimePorts = {
    invoke,
    abortSignal: (ms) => AbortSignal.timeout(ms),
    open: (link) => (link.reveal ? ports.revealItemInDir(link.path) : ports.openPath(link.path)),
    setRailHealth,
    openPath: openVia("openPath", "openPath"),
    revealItemInDir: openVia("revealItemInDir", "revealItemInDir"),
    openUrl: openVia("openUrl", "openUrl"),
    homeDir: async () => "",
    emit: async (event, payload) => {
      portLog(`ports: emit ${event} ${JSON.stringify(payload ?? null)} ignored outside tauri`);
    },
    findWindow: async () => null,
    window: {
      hide: logged("window.hide"),
      show: logged("window.show"),
      minimize: logged("window.minimize"),
      toggleMaximize: logged("window.toggleMaximize"),
      startDragging: logged("window.startDragging"),
      setFocus: logged("window.setFocus"),
      setIgnoreCursorEvents: async (ignore) => {
        portLog(`ports: window.setIgnoreCursorEvents(${ignore}) ignored outside tauri`);
      },
      setVisibleOnAllWorkspaces: async (all) => {
        portLog(`ports: window.setVisibleOnAllWorkspaces(${all}) ignored outside tauri`);
      },
      setSize: async (width, height) => {
        portLog(`ports: window.setSize(${width}, ${height}) ignored outside tauri`);
      },
      setPosition: async (x, y) => {
        portLog(`ports: window.setPosition(${x}, ${y}) ignored outside tauri`);
      },
      scaleFactor: async () => 1,
      outerPosition: async () => ({ x: 0, y: 0 }),
      outerSize: async () => ({ width: 0, height: 0 }),
      onFocusChanged: async () => {
        portLog("ports: window.onFocusChanged ignored outside tauri");
        return () => {};
      },
    },
    webview: {
      setZoom: logged("webview.setZoom"),
      onDragDrop: async () => {
        portLog("ports: webview.onDragDrop ignored outside tauri");
        return () => {};
      },
    },
  };
  return ports;
}

// Chosen the same way as the transport: Tauri internals present = real window
// and opener APIs; a plain browser gets stubs over the ws transport.
export const runtimePorts: RuntimePorts = hasTauriInternals()
  ? tauriPorts()
  : browserPorts(pickTransport());
