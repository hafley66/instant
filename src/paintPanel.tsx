// Paint panel backed by one miniPaint iframe per dock panel instance.
import { useEffect, useRef } from "react";
import { SignalReact } from "@hafley66/signals/react";
import type { IDockviewPanelProps } from "dockview";
import { registerPlugin, type RailChild } from "./plugin";
import { setDirtyProbe } from "./dirtyGuard";
import { installPaintBridge } from "./paintBridge";
import {
  loadPaintFile,
  paintPanelState,
  paintSession,
  discardPaintSession,
  releasePaintPanelState,
  savePaint,
  requestLoadPaintFile,
  deletePaintFile,
  copyPaintImage,
  PAINT_SIDEBAR_RECENT_CAP,
  type PaintPanelState,
} from "./paintSessions";
import { openPanelInstance } from "./reactdock";
import { baseName } from "./core";

const PANEL_ID = "paint";

interface PaintInstanceProps {
  panelId: string;
  initialPath?: string;
}

const PaintEditor = SignalReact(function PaintEditor({ panelId, initialPath }: PaintInstanceProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const stateRef = useRef<PaintPanelState | null>(null);
  const quicksaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const state = stateRef.current ?? paintPanelState(panelId);
  stateRef.current = state;
  const current = state.current.$();
  const edits = state.edits.$();
  const session = paintSession.$();

  const scheduleQuicksave = () => {
    if (quicksaveTimer.current) clearTimeout(quicksaveTimer.current);
    quicksaveTimer.current = setTimeout(() => {
      quicksaveTimer.current = null;
      state.bridge?.quicksave();
    }, 1_500);
  };

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const disposeDirtyProbe = setDirtyProbe(
      panelId,
      () =>
        state.edits.$() > 0
          ? `“${baseName(state.current.$()) || "untitled painting"}” has unsaved changes.`
          : null,
    );
    const onLoad = () => {
      const bridge = installPaintBridge(
        iframe,
        {
          onEdit: () => {
            state.edits.$(state.edits.$() + 1);
            scheduleQuicksave();
          },
          onClean: () => state.edits.$(0),
        },
        panelId,
      );
      state.bridge = bridge;
      const target = initialPath || state.current.$() || (panelId === PANEL_ID ? paintSession.$().lastPath : null);
      if (bridge?.hasQuicksave()) bridge.quickload();
      else if (initialPath) void loadPaintFile(state, initialPath);
      else if (target) void loadPaintFile(state, target);
    };
    iframe.addEventListener("load", onLoad);
    return () => {
      iframe.removeEventListener("load", onLoad);
      disposeDirtyProbe();
      if (quicksaveTimer.current) clearTimeout(quicksaveTimer.current);
      if (state.edits.$() > 0) state.bridge?.quicksave();
      state.bridge?.destroy();
      state.bridge = null;
      releasePaintPanelState(panelId);
    };
  }, [initialPath, panelId, state]);

  return (
    <div className="v2-panel paint-root">
      <div className="act-bar">
        <span
          className="paint-dirty-dot"
          title={edits > 0 ? "unsaved changes" : "no unsaved changes"}
          style={{ opacity: edits > 0 ? 1 : 0.25, color: edits > 0 ? "#c0392b" : "inherit" }}
        >
          ●
        </span>
        <input
          className="paint-path"
          type="text"
          placeholder="path to open / save (PNG)…"
          value={current}
          spellCheck={false}
          onChange={(e) => state.current.$(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && current.trim()) void requestLoadPaintFile(state, current.trim());
          }}
          style={{ flex: 1, minWidth: 80 }}
        />
        <button type="button" disabled={!current.trim()} onClick={() => void requestLoadPaintFile(state, current.trim())}>
          open
        </button>
        <button type="button" onClick={() => void savePaint(state)} title="flatten layers and save as PNG">
          save
        </button>
        <button type="button" onClick={() => void copyPaintImage(state)} title="copy the composited image to the system clipboard">
          copy
        </button>
        {session.recent.length ? (
          <select
            className="paint-recent"
            value=""
            title="recent paintings"
            onChange={(e) => {
              if (e.target.value) void requestLoadPaintFile(state, e.target.value);
            }}
          >
            <option value="">recent…</option>
            {session.recent.map((path) => (
              <option key={path} value={path} title={path}>
                {baseName(path)}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <iframe
        ref={iframeRef}
        className="paint-frame"
        src="/vendor/miniPaint/index.html"
        title="miniPaint layers image editor"
        style={{ flex: 1, minHeight: 0, width: "100%", border: 0, display: "block", background: "#fff" }}
      />
    </div>
  );
});

function PaintDefault(props: IDockviewPanelProps) {
  return <PaintEditor panelId={String(props.params.panelId ?? PANEL_ID)} />;
}

function PaintInstance(props: IDockviewPanelProps) {
  return (
    <PaintEditor
      panelId={String(props.params.panelId ?? "")}
      initialPath={String(props.params.path ?? "")}
    />
  );
}

export function openPaintFile(path: string): void {
  openPanelInstance("paint", path, baseName(path), { path });
}

export function registerPaint() {
  registerPlugin({
    id: "paint",
    panels: [
      {
        id: PANEL_ID,
        title: "Paint",
        icon: "🎨",
        iconLabel: "Paint",
        component: PaintDefault,
        keepAlive: true,
        onDiscard: discardPaintSession,
        railChildren: async (): Promise<RailChild[]> =>
          paintSession.$().recent.slice(0, PAINT_SIDEBAR_RECENT_CAP).map((path) => ({
            id: path,
            label: baseName(path),
            hint: path,
            run: () => openPaintFile(path),
            dragPath: path,
            contextMenu: () => [
              { label: "Delete file…", action: () => void deletePaintFile(path) },
            ],
          })),
      },
    ],
    instances: [
      {
        id: "paint",
        prefix: "paint:",
        componentName: "paint-instance",
        component: PaintInstance,
        keepAlive: true,
        onDiscard: discardPaintSession,
      },
    ],
  });
}
