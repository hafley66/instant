// Kitty-graphics overlay compositor.
//
// The Rust proxy (src-tauri/src/kitty.rs) resolves kitty APC graphics frames —
// including awrit's shared-memory frames the webview can't open itself — to RGBA
// and emits them as `pty-graphics` events. This draws them onto a <canvas> laid
// over the xterm screen.
//
// awrit sends the whole device-pixel framebuffer each paint at x=0,y=0, so the
// common path is a full-frame blit. We size the canvas backing store to the
// frame's pixel dimensions and stretch it to the host via CSS (100%), which maps
// 1:1 to physical pixels because the pty's reported pixel size is cellPx*grid.

export type GraphicsFrame = {
  id: string;
  action: string;
  img_id: number;
  format: number;
  width: number;
  height: number;
  x: number;
  y: number;
  no_scroll: boolean;
  delete: boolean;
  rgba_b64: string;
};

export class GraphicsOverlay {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private pending: GraphicsFrame | null = null;
  private raf = 0;

  constructor(host: HTMLElement) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "term-graphics";
    Object.assign(this.canvas.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      pointerEvents: "none", // input still goes to xterm's textarea
      zIndex: "5",
    } satisfies Partial<CSSStyleDeclaration>);
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
  }

  // Coalesce to the newest frame; awrit repaints faster than we can composite, so
  // dropping stale full-frames is correct and keeps us at display cadence.
  push(f: GraphicsFrame) {
    if (f.delete) {
      this.clear();
      return;
    }
    this.pending = f;
    if (!this.raf) this.raf = requestAnimationFrame(() => this.flush());
  }

  private flush() {
    this.raf = 0;
    const f = this.pending;
    this.pending = null;
    if (!f || f.width <= 0 || f.height <= 0) return;
    const bytes = b64ToBytes(f.rgba_b64);
    const need = f.width * f.height * 4;
    if (bytes.length < need) return;
    if (this.canvas.width !== f.width || this.canvas.height !== f.height) {
      this.canvas.width = f.width;
      this.canvas.height = f.height;
    }
    const img = new ImageData(
      new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, need),
      f.width,
      f.height,
    );
    this.ctx.putImageData(img, f.x, f.y);
  }

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  dispose() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.canvas.remove();
  }
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
