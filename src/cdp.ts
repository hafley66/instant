// CDP browser view: a canvas that shows a headless-Chrome tab's JPEG screencast
// (Rust forwards frames as `cdp-frame`) and forwards input back as CDP
// Input.dispatch* commands. Unlike the kitty overlay this canvas *captures*
// pointer + keyboard and drives the page; resize is real (Emulation override).

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

type FrameEvent = { id: string; data: string };

// CDP modifier bitfield: Alt=1, Ctrl=2, Meta=4, Shift=8.
function cdpMods(e: KeyboardEvent | MouseEvent): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

const MOUSE_BTN = ["left", "middle", "right"] as const;

export class CdpView {
  readonly el: HTMLDivElement;
  private urlbar: HTMLInputElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private img = new Image();
  private pendingData: string | null = null;
  private raf = 0;
  private unlisten?: UnlistenFn;
  private unlistenCursor?: UnlistenFn;
  private ro: ResizeObserver;
  private resizeTimer = 0;
  private dragging = false;
  private lastMove: MouseEvent | null = null;
  private moveRaf = 0;

  constructor(host: HTMLElement, private id: string, url: string) {
    this.el = document.createElement("div");
    Object.assign(this.el.style, {
      position: "absolute",
      inset: "0",
      display: "flex",
      flexDirection: "column",
      background: "#1e1e1e",
    } satisfies Partial<CSSStyleDeclaration>);

    // Minimal URL bar: Enter navigates.
    this.urlbar = document.createElement("input");
    this.urlbar.value = url;
    this.urlbar.spellcheck = false;
    Object.assign(this.urlbar.style, {
      flex: "0 0 auto",
      font: "12px monospace",
      padding: "4px 8px",
      border: "none",
      outline: "none",
      background: "#2a2a2a",
      color: "#ddd",
    } satisfies Partial<CSSStyleDeclaration>);
    this.urlbar.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const u = this.normalizeUrl(this.urlbar.value.trim());
        if (u) invoke("cdp_navigate", { id: this.id, url: u }).catch(console.error);
        this.canvas.focus();
      }
      e.stopPropagation(); // don't leak typing to the page
    });

    this.canvas = document.createElement("canvas");
    this.canvas.tabIndex = 0; // focusable for keyboard
    Object.assign(this.canvas.style, {
      flex: "1 1 auto",
      width: "100%",
      minHeight: "0",
      outline: "none",
      cursor: "default",
      background: "#fff",
    } satisfies Partial<CSSStyleDeclaration>);
    this.ctx = this.canvas.getContext("2d")!;

    this.el.append(this.urlbar, this.canvas);
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    host.appendChild(this.el);

    this.img.onload = () => {
      const { naturalWidth: w, naturalHeight: h } = this.img;
      if (w && h) {
        if (this.canvas.width !== w || this.canvas.height !== h) {
          this.canvas.width = w;
          this.canvas.height = h;
        }
        this.ctx.drawImage(this.img, 0, 0);
      }
    };

    this.wireInput();
    this.ro = new ResizeObserver(() => this.scheduleResize());
    this.ro.observe(this.canvas);

    void listen<FrameEvent>("cdp-frame", (ev) => {
      if (ev.payload.id !== this.id) return;
      this.pendingData = ev.payload.data;
      if (!this.raf) this.raf = requestAnimationFrame(() => this.flush());
    }).then((u) => (this.unlisten = u));

    // Native cursor: the page reports the CSS cursor under the pointer; mirror it
    // onto the canvas so links show a hand, text a beam, etc. CSS keywords map
    // 1:1 to canvas style.cursor; custom url() cursors fall back to default.
    void listen<{ id: string; cursor: string }>("cdp-cursor", (ev) => {
      if (ev.payload.id !== this.id) return;
      const c = ev.payload.cursor;
      this.canvas.style.cursor = !c || c.startsWith("url(") ? "default" : c;
    }).then((u) => (this.unlistenCursor = u));
  }

  // CSS px size of the canvas (== CDP viewport CSS px) and the device ratio.
  private metrics() {
    const r = this.canvas.getBoundingClientRect();
    return {
      width: Math.max(1, Math.round(r.width)),
      height: Math.max(1, Math.round(r.height)),
      dpr: window.devicePixelRatio || 1,
    };
  }

  /** Send the initial viewport so cdp_open can start the screencast sized. */
  initialMetrics() {
    return this.metrics();
  }

  private flush() {
    this.raf = 0;
    const d = this.pendingData;
    this.pendingData = null;
    if (d) this.img.src = "data:image/jpeg;base64," + d;
  }

  private scheduleResize() {
    clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      const m = this.metrics();
      invoke("cdp_resize", { id: this.id, width: m.width, height: m.height, dpr: m.dpr }).catch(
        console.error,
      );
    }, 120);
  }

  private pos(e: MouseEvent) {
    const r = this.canvas.getBoundingClientRect();
    return { x: Math.round(e.clientX - r.left), y: Math.round(e.clientY - r.top) };
  }

  private mouse(type: string, e: MouseEvent, extra: Record<string, unknown> = {}) {
    const { x, y } = this.pos(e);
    invoke("cdp_send", {
      id: this.id,
      method: "Input.dispatchMouseEvent",
      params: { type, x, y, modifiers: cdpMods(e), ...extra },
    }).catch(console.error);
  }

  // While a button is held, mousemove/up are tracked on the window so a drag
  // (text select, slider, scrollbar) keeps going and *completes* even when the
  // pointer leaves the canvas — otherwise the page gets a stuck, never-released
  // button. Moves are coalesced to one per frame to avoid flooding the IPC.
  private onWinMove = (e: MouseEvent) => this.queueMove(e);
  private onWinUp = (e: MouseEvent) => {
    this.dragging = false;
    this.mouse("mouseReleased", e, {
      button: MOUSE_BTN[e.button] ?? "left",
      buttons: e.buttons,
      clickCount: e.detail || 1,
    });
    window.removeEventListener("mousemove", this.onWinMove, true);
    window.removeEventListener("mouseup", this.onWinUp, true);
  };

  private queueMove(e: MouseEvent) {
    this.lastMove = e;
    if (!this.moveRaf) {
      this.moveRaf = requestAnimationFrame(() => {
        this.moveRaf = 0;
        const m = this.lastMove;
        if (m) this.mouse("mouseMoved", m, { button: "none", buttons: m.buttons });
      });
    }
  }

  private wireInput() {
    const c = this.canvas;
    c.addEventListener("mousedown", (e) => {
      e.preventDefault();
      c.focus();
      this.dragging = true;
      this.mouse("mousePressed", e, {
        button: MOUSE_BTN[e.button] ?? "left",
        buttons: e.buttons || 1,
        clickCount: e.detail || 1,
      });
      window.addEventListener("mousemove", this.onWinMove, true);
      window.addEventListener("mouseup", this.onWinUp, true);
    });
    c.addEventListener("mousemove", (e) => {
      if (!this.dragging) this.queueMove(e);
    });
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        // Pass the OS-provided deltas straight through (no negation) so scroll
        // matches the rest of the system instead of feeling inverted.
        this.mouse("mouseWheel", e, { deltaX: e.deltaX, deltaY: e.deltaY });
      },
      { passive: false },
    );
    c.addEventListener("keydown", (e) => this.key(e));
    c.addEventListener("keyup", (e) => this.key(e));
  }

  private key(e: KeyboardEvent) {
    // Let app shortcuts (⌘⇧P, ⌘W, …) through to the window; everything else goes
    // to the page.
    if (e.metaKey && (e.key === "w" || e.key === "p" || e.key === "t")) return;
    e.preventDefault();
    e.stopPropagation();
    const printable = [...e.key].length === 1 || e.key === "Enter" || e.key === "Tab";
    let text: string | undefined;
    if (e.key === "Enter") text = "\r";
    else if (e.key === "Tab") text = "\t";
    else if ([...e.key].length === 1) text = e.key;
    const type = e.type === "keyup" ? "keyUp" : printable ? "keyDown" : "rawKeyDown";
    invoke("cdp_send", {
      id: this.id,
      method: "Input.dispatchKeyEvent",
      params: {
        type,
        key: e.key,
        code: e.code,
        windowsVirtualKeyCode: e.keyCode,
        nativeVirtualKeyCode: e.keyCode,
        text: e.type === "keyup" ? undefined : text,
        unmodifiedText: e.type === "keyup" ? undefined : text,
        autoRepeat: e.repeat,
        modifiers: cdpMods(e),
      },
    }).catch(console.error);
  }

  private normalizeUrl(s: string): string {
    if (!s) return "";
    if (/^[a-z]+:\/\//i.test(s) || s.startsWith("about:")) return s;
    if (/^\S+\.\S+/.test(s)) return "https://" + s;
    return "https://www.google.com/search?q=" + encodeURIComponent(s);
  }

  focus() {
    this.canvas.focus();
  }

  dispose() {
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.moveRaf) cancelAnimationFrame(this.moveRaf);
    clearTimeout(this.resizeTimer);
    window.removeEventListener("mousemove", this.onWinMove, true);
    window.removeEventListener("mouseup", this.onWinUp, true);
    this.ro.disconnect();
    this.unlisten?.();
    this.unlistenCursor?.();
    this.el.remove();
  }
}
