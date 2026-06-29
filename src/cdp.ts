// CDP browser view: a canvas that shows a headless-Chrome tab's JPEG screencast
// (Rust forwards frames as `cdp-frame`) and forwards input back as CDP
// Input.dispatch* commands. Unlike the kitty overlay this canvas *captures*
// pointer + keyboard and drives the page; resize is real (Emulation override).

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { runMatchingCommand } from "./keymap";

type FrameEvent = { id: string; data: string };

// CDP modifier bitfield: Alt=1, Ctrl=2, Meta=4, Shift=8.
function cdpMods(e: KeyboardEvent | MouseEvent): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

const MOUSE_BTN = ["left", "middle", "right"] as const;

// JPEG quality of the screencast (30–100). Higher = sharper, more bytes/frame.
// Persisted so a chosen level sticks across sessions; cycled via the palette.
const QUALITY_KEY = "cdp.quality";
const DEFAULT_QUALITY = 90;
export const QUALITY_STEPS = [75, 90, 100] as const;

export function cdpQuality(): number {
  const v = Number(localStorage.getItem(QUALITY_KEY));
  return Number.isFinite(v) && v >= 30 && v <= 100 ? v : DEFAULT_QUALITY;
}

export function setCdpQuality(q: number): number {
  const clamped = Math.max(30, Math.min(100, Math.round(q)));
  localStorage.setItem(QUALITY_KEY, String(clamped));
  return clamped;
}

export class CdpView {
  readonly el: HTMLDivElement;
  private urlbar: HTMLInputElement;
  private backBtn!: HTMLButtonElement;
  private fwdBtn!: HTMLButtonElement;
  // Per-tab session history mirror. `urls[idx]` is the current page. Back/forward
  // drive the page's own history.back()/forward() (so scroll + form state come
  // back natively); this stack only tracks position to enable/disable the buttons
  // and detect new vs. history navigations. `pendingNav` flags a navigation we
  // triggered (-1 back, +1 forward) so the resulting cdp-url shifts idx instead
  // of pushing a new entry.
  private urls: string[] = [];
  private idx = -1;
  private pendingNav: -1 | 0 | 1 = 0;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private img = new Image();
  private pendingData: string | null = null;
  private raf = 0;
  private unlisten?: UnlistenFn;
  private unlistenCursor?: UnlistenFn;
  private unlistenUrl?: UnlistenFn;
  private unlistenCopy?: UnlistenFn;
  private ro: ResizeObserver;
  private resizeTimer = 0;
  private dragging = false;
  private lastMove: MouseEvent | null = null;
  private moveRaf = 0;
  private zoom = 1;

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
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.canvas.focus(); // bail back to the page without navigating
      }
      e.stopPropagation(); // don't leak typing to the page
    });
    // Omnibar feel: focusing the bar selects all so you can just type a new
    // destination (URL or search terms) over the current address.
    this.urlbar.addEventListener("focus", () => this.urlbar.select());

    // Nav row: back / forward / reload buttons sit left of the URL bar.
    const navrow = document.createElement("div");
    Object.assign(navrow.style, {
      flex: "0 0 auto",
      display: "flex",
      alignItems: "stretch",
      background: "#2a2a2a",
    } satisfies Partial<CSSStyleDeclaration>);
    const mkBtn = (glyph: string, title: string, on: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = glyph;
      b.title = title;
      Object.assign(b.style, {
        flex: "0 0 auto",
        width: "28px",
        border: "none",
        outline: "none",
        background: "transparent",
        color: "#ddd",
        font: "13px monospace",
        cursor: "pointer",
      } satisfies Partial<CSSStyleDeclaration>);
      // Don't let a button click steal focus from / blur the page selection.
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => { on(); this.canvas.focus(); });
      return b;
    };
    this.backBtn = mkBtn("‹", "Back", () => this.goBack());
    this.fwdBtn = mkBtn("›", "Forward", () => this.goForward());
    const reloadBtn = mkBtn("↻", "Reload", () => this.reload());
    navrow.append(this.backBtn, this.fwdBtn, reloadBtn, this.urlbar);
    this.urlbar.style.flex = "1 1 auto";
    this.updateNavButtons();

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

    this.el.append(navrow, this.canvas);
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

    // Address-bar sync: the page reports its URL on navigation (link click,
    // redirect, SPA pushState). Reflect it unless the user is mid-edit in the bar.
    void listen<{ id: string; url: string }>("cdp-url", (ev) => {
      if (ev.payload.id !== this.id) return;
      if (document.activeElement !== this.urlbar) this.urlbar.value = ev.payload.url;
      this.onNavigated(ev.payload.url);
      // CSS zoom is per-document; re-apply after a navigation if it isn't 1.
      if (this.zoom !== 1) this.applyZoom();
    }).then((u) => (this.unlistenUrl = u));

    // Copy bridge: the page pushes its selection over __cdpCopy on ⌘C; write it
    // to the OS clipboard so it pastes into other apps.
    void listen<{ id: string; text: string }>("cdp-copy", (ev) => {
      if (ev.payload.id !== this.id) return;
      if (ev.payload.text) navigator.clipboard.writeText(ev.payload.text).catch(console.error);
    }).then((u) => (this.unlistenCopy = u));
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
    this.resizeTimer = window.setTimeout(() => this.applyMetrics(), 120);
  }

  /** Push current size + the active quality to the screencast (restarts it). */
  applyMetrics() {
    const m = this.metrics();
    invoke("cdp_resize", {
      id: this.id,
      width: m.width,
      height: m.height,
      dpr: m.dpr,
      quality: cdpQuality(),
    }).catch(console.error);
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
    // ⌘/⌃ combos: handle the browser-local ones here, and let everything else
    // bubble to the app keymap (tab switch, ⌘W close, ⌘⇧P palette, …). The old
    // code stopPropagation'd every key, which is why tab controls died on a
    // browser tab. We only act on keydown for these; the matching keyup bubbles.
    if (e.metaKey || e.ctrlKey) {
      if (e.type !== "keydown") return; // let keyup bubble
      const k = e.key.toLowerCase();
      if (k === "l") { e.preventDefault(); e.stopPropagation(); this.urlbar.focus(); return; }
      if (k === "r") {
        e.preventDefault();
        e.stopPropagation();
        this.reload();
        return;
      }
      // Chrome-on-mac back/forward: ⌘[ / ⌘] (plain — ⌘⇧[ / ] stays the app's tab
      // switch, handled by runMatchingCommand below). Also accept ⌘← / ⌘→.
      if ((k === "[" && !e.shiftKey) || e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        this.goBack();
        return;
      }
      if ((k === "]" && !e.shiftKey) || e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        this.goForward();
        return;
      }
      // Clipboard bridge: the headless page has its own clipboard, so route copy/
      // paste through the OS clipboard explicitly. Copy pushes the page selection
      // out via the __cdpCopy binding (handled in the cdp-copy listener); paste
      // reads the OS clipboard and inserts it at the page's focus.
      if (k === "c") {
        e.preventDefault();
        e.stopPropagation();
        invoke("cdp_send", {
          id: this.id,
          method: "Runtime.evaluate",
          params: { expression: "window.__cdpCopy((window.getSelection&&getSelection().toString())||'')" },
        }).catch(console.error);
        return;
      }
      if (k === "v") {
        e.preventDefault();
        e.stopPropagation();
        navigator.clipboard.readText().then((text) => {
          if (text) invoke("cdp_send", { id: this.id, method: "Input.insertText", params: { text } });
        }).catch(console.error);
        return;
      }
      if (k === "a") {
        e.preventDefault();
        e.stopPropagation();
        invoke("cdp_send", {
          id: this.id,
          method: "Runtime.evaluate",
          params: { expression: "document.execCommand('selectAll')" },
        }).catch(console.error);
        return;
      }
      if (k === "=" || k === "+") { e.preventDefault(); e.stopPropagation(); this.setZoom(this.zoom + 0.1); return; }
      if (k === "-" || k === "_") { e.preventDefault(); e.stopPropagation(); this.setZoom(this.zoom - 0.1); return; }
      if (k === "0") { e.preventDefault(); e.stopPropagation(); this.setZoom(1); return; }
      // Everything else (⌘1-9, ⌘W, ⌘⇧P, ⌘⇧[ / ]) goes to the app keymap. Run it
      // through the app's own matcher rather than relying on the event bubbling
      // to the window tinykeys listener: tinykeys won't match BracketLeft/Right
      // once Shift turns the key into { / }, so tab-switch was dead on browser
      // tabs. runMatchingCommand handles those bindings (it powers terminals too).
      if (runMatchingCommand(e)) {
        e.stopPropagation();
        return;
      }
      return; // unmatched ⌘ combo: let it bubble
    }
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

  // Fold one navigation into the per-tab history mirror. A nav we triggered
  // (pendingNav) just shifts idx; anything else is a new navigation that
  // truncates the forward entries and appends — same as a browser's address bar.
  private onNavigated(url: string) {
    if (this.pendingNav === -1) {
      this.idx = Math.max(0, this.idx - 1);
      this.pendingNav = 0;
    } else if (this.pendingNav === 1) {
      this.idx = Math.min(this.urls.length - 1, this.idx + 1);
      this.pendingNav = 0;
    } else if (this.urls[this.idx] !== url) {
      this.urls = this.urls.slice(0, this.idx + 1);
      this.urls.push(url);
      this.idx = this.urls.length - 1;
    }
    this.updateNavButtons();
  }

  private updateNavButtons() {
    if (this.backBtn) this.backBtn.disabled = this.idx <= 0;
    if (this.fwdBtn) this.fwdBtn.disabled = this.idx >= this.urls.length - 1;
    const dim = (b: HTMLButtonElement) => (b.style.opacity = b.disabled ? "0.3" : "1");
    if (this.backBtn) dim(this.backBtn);
    if (this.fwdBtn) dim(this.fwdBtn);
  }

  // Back/forward run the page's own session history so scroll position and form
  // state restore natively; the resulting cdp-url is reconciled in onNavigated.
  goBack() {
    if (this.idx <= 0) return;
    this.pendingNav = -1;
    this.evalJs("history.back()");
  }

  goForward() {
    if (this.idx >= this.urls.length - 1) return;
    this.pendingNav = 1;
    this.evalJs("history.forward()");
  }

  reload() {
    invoke("cdp_send", { id: this.id, method: "Page.reload", params: {} }).catch(console.error);
  }

  private evalJs(expression: string) {
    invoke("cdp_send", {
      id: this.id,
      method: "Runtime.evaluate",
      params: { expression },
    }).catch(console.error);
  }

  // Page zoom via CSS zoom on the document element (reflows like Chrome's own
  // ⌘+/-). Clamped 25%–500%. CSS zoom resets on navigation, so it's re-applied
  // from the cdp-url listener whenever it isn't 1.
  private setZoom(z: number) {
    this.zoom = Math.max(0.25, Math.min(5, Math.round(z * 100) / 100));
    this.applyZoom();
  }

  private applyZoom() {
    invoke("cdp_send", {
      id: this.id,
      method: "Runtime.evaluate",
      params: { expression: `document.documentElement.style.zoom=${this.zoom}` },
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
    this.unlistenUrl?.();
    this.unlistenCopy?.();
    this.el.remove();
  }
}
