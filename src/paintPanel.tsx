// Paint panel: miniPaint (MIT, https://github.com/viliusle/miniPaint) — an
// open-source Photoshop-style editor with a real multi-layer system — vendored
// into public/vendor/miniPaint by scripts/vendor-minipaint.sh and embedded via
// its official iframe integration. Everything runs locally in the webview.
//
// Known gap (documented for the sample): miniPaint's File→Save produces a
// browser download, which Tauri's WKWebView may not deliver to disk. Open,
// clipboard paste, and all editing work. A save_meme-style Rust bridge is the
// follow-up if this graduates from the sample.
import { registerPlugin } from "./plugin";

function PaintPanel() {
  return (
    <iframe
      className="paint-frame"
      src="/vendor/miniPaint/index.html"
      title="miniPaint — layers image editor"
      style={{ width: "100%", height: "100%", border: 0, display: "block", background: "#fff" }}
    />
  );
}

export function registerPaint() {
  registerPlugin({
    id: "paint",
    panels: [
      {
        id: "paint",
        title: "Paint",
        icon: "🎨",
        iconLabel: "Paint",
        component: PaintPanel,
      },
    ],
  });
}
