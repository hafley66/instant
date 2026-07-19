// Paint panel: miniPaint (MIT, https://github.com/viliusle/miniPaint) — an
// open-source Photoshop-style editor with a real multi-layer system — vendored
// into public/vendor/miniPaint by scripts/vendor-minipaint.sh and embedded via
// its official iframe integration. Everything runs locally in the webview.
//
// The instant toolbar above the iframe is the disk bridge (miniPaint's own
// File>Save goes through a browser download, which Tauri may not deliver):
// save flattens layers via the same-origin bridge (paintBridge.ts) and writes
// through the save_meme Rust command; open/load read via read_image. Sessions
// (recent files + resume-last) live in paintSessions.ts. Unsaved edits signal
// the tab wrapper through the generic dirty guard (dirtyGuard.ts), so closing
// the tab with changes asks first.
import { useEffect, useRef } from "react";
import { SignalReact } from "@hafley66/signals/react";
import { registerPlugin, type RailChild } from "./plugin";
import { setDirtyProbe } from "./dirtyGuard";
import { installPaintBridge, setActivePaintBridge, activePaintBridge } from "./paintBridge";
import {
  loadPaintFile,
  paintCurrent,
  paintEdits,
  paintSession,
  savePaint,
} from "./paintSessions";
import { focusPanelById, isOpen, togglePanel } from "./reactdock";
import { baseName } from "./core";

const PANEL_ID = "paint";

// A file asked for while the panel/iframe wasn't up yet — consumed once the
// bridge installs (see the iframe load handler).
let pendingOpen: string | null = null;

// Open a file in the Paint panel from anywhere (rail children, future links):
// raise the panel, then load — now if the bridge is live, else on iframe load
// (pendingOpen survives until the load handler consumes it).
export function openPaintFile(path: string): void {
  pendingOpen = path;
  if (!isOpen(PANEL_ID)) togglePanel(PANEL_ID);
  else focusPanelById(PANEL_ID);
  if (activePaintBridge()) {
    pendingOpen = null;
    void loadPaintFile(path);
  }
}

const PaintPanel = SignalReact(function PaintPanel() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const current = paintCurrent.$();
  const edits = paintEdits.$();
  const session = paintSession.$();
  const dirty = edits > 0;

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const onLoad = () => {
      const bridge = installPaintBridge(iframe, {
        onEdit: () => paintEdits.$(paintEdits.$() + 1),
        onClean: () => paintEdits.$(0),
      });
      setActivePaintBridge(bridge);
      // Session resume: an explicit request wins, else the last-opened file.
      const target = pendingOpen ?? paintSession.$().lastPath;
      pendingOpen = null;
      if (target) void loadPaintFile(target);
    };
    iframe.addEventListener("load", onLoad);
    return () => {
      iframe.removeEventListener("load", onLoad);
      setActivePaintBridge(null);
    };
  }, []);

  // The tab wrapper's dirty guard (close ✕ / ⌘W / rail toggle consults it).
  useEffect(
    () =>
      setDirtyProbe(
        PANEL_ID,
        () =>
          paintEdits.$() > 0
            ? `“${baseName(paintCurrent.$()) || "untitled painting"}” has unsaved changes.`
            : null,
      ),
    [],
  );

  return (
    <div className="v2-panel paint-root">
      <div className="act-bar">
        <span
          className="paint-dirty-dot"
          title={dirty ? "unsaved changes" : "no unsaved changes"}
          style={{ opacity: dirty ? 1 : 0.25, color: dirty ? "#c0392b" : "inherit" }}
        >
          ●
        </span>
        <input
          className="paint-path"
          type="text"
          placeholder="path to open / save (PNG)…"
          value={current}
          spellCheck={false}
          onChange={(e) => paintCurrent.$(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && current.trim()) void loadPaintFile(current.trim());
          }}
          style={{ flex: 1, minWidth: 80 }}
        />
        <button
          type="button"
          disabled={!current.trim()}
          onClick={() => void loadPaintFile(current.trim())}
          title="open this file in the editor"
        >
          open
        </button>
        <button type="button" onClick={() => void savePaint()} title="flatten layers and save as PNG">
          save
        </button>
        {session.recent.length ? (
          <select
            className="paint-recent"
            value=""
            title="recent paintings"
            onChange={(e) => {
              if (e.target.value) void loadPaintFile(e.target.value);
            }}
          >
            <option value="">recent…</option>
            {session.recent.map((p) => (
              <option key={p} value={p} title={p}>
                {baseName(p)}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <iframe
        ref={iframeRef}
        className="paint-frame"
        src="/vendor/miniPaint/index.html"
        title="miniPaint — layers image editor"
        style={{ flex: 1, minHeight: 0, width: "100%", border: 0, display: "block", background: "#fff" }}
      />
    </div>
  );
});

export function registerPaint() {
  registerPlugin({
    id: "paint",
    panels: [
      {
        id: PANEL_ID,
        title: "Paint",
        icon: "🎨",
        iconLabel: "Paint",
        component: PaintPanel,
        // The paint "session history": recent files under the rail button.
        railChildren: async (): Promise<RailChild[]> =>
          paintSession.$().recent.map((p) => ({
            id: p,
            label: baseName(p),
            hint: p,
            run: () => openPaintFile(p),
          })),
      },
    ],
  });
}
