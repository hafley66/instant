// CDP browser view: a canvas that shows a headless-Chrome tab's JPEG screencast
// (Rust forwards frames as `cdp-frame`) and forwards input back as CDP
// Input.dispatch* commands. Unlike the kitty overlay this canvas *captures*
// pointer + keyboard and drives the page; resize is real (Emulation override).

import { invoke } from "./generated/native";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { runMatchingCommand } from "./keymap";
import { history as navHistory } from "./nav";
import { fuzzyFilter } from "./fuzzy";

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

// Performance mode: render the screencast at 1x instead of the display's device
// pixel ratio. On a retina panel that's 4x fewer pixels per frame (2x each axis),
// which roughly quarters encode + transport + decode time — the biggest single
// lever on the lip-sync lag, at the cost of slightly softer text.
const PERF_KEY = "cdp.perf";
export function cdpPerf(): boolean {
  return localStorage.getItem(PERF_KEY) === "1";
}
export function setCdpPerf(on: boolean): void {
  localStorage.setItem(PERF_KEY, on ? "1" : "0");
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
  // Target index for a multi-step jump (history.go) from the back/forward menu;
  // the next cdp-url lands idx here instead of stepping by one.
  private pendingTarget: number | null = null;
  private histMenu!: HTMLDivElement;
  // Omnibar suggestion dropdown: recent history when the bar is empty, fuzzy
  // matches over history while typing. suggestIdx is the keyboard-highlighted row.
  private suggestBox!: HTMLDivElement;
  private suggestions: string[] = [];
  private suggestIdx = -1;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private pendingData: string | null = null;
  private raf = 0;
  // Monotonic frame id so an out-of-order async decode never paints over a newer
  // frame (newest-wins): a decode only draws if it's still the latest issued.
  private drawSeq = 0;
  private unlisten?: UnlistenFn;
  private unlistenCursor?: UnlistenFn;
  private unlistenUrl?: UnlistenFn;
  private unlistenCopy?: UnlistenFn;
  private ro: ResizeObserver;
  // Stream gating: stop the screencast while the tab is hidden (panel switched
  // away or the display/app is not visible) so a backgrounded page — especially
  // a playing video — isn't decoding full frames into an off-screen canvas, and
  // restart it (fresh frame) the moment it's shown again.
  private io?: IntersectionObserver;
  private inViewport = true;
  private paused = false; // true while the screencast is stopped (tab hidden)
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
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.moveSuggest(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        this.moveSuggest(-1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        // A highlighted suggestion wins; otherwise treat the typed text as a
        // URL / search (normalizeUrl decides).
        const pick = this.suggestIdx >= 0 ? this.suggestions[this.suggestIdx] : null;
        this.navigateTo(pick ?? this.urlbar.value.trim());
      } else if (e.key === "Escape") {
        e.preventDefault();
        if (this.suggestBox.style.display !== "none") this.hideSuggest();
        else this.canvas.focus(); // bail back to the page without navigating
      }
      e.stopPropagation(); // don't leak typing to the page
    });
    this.urlbar.addEventListener("input", () => this.openSuggest());
    // Omnibar feel: focusing the bar selects all so you can just type a new
    // destination (URL or search terms) over the current address, and surfaces
    // recent history immediately.
    this.urlbar.addEventListener("focus", () => {
      this.urlbar.select();
      this.openSuggest();
    });
    // Delay the close so a click on a suggestion (which blurs the input) still
    // lands on the row's mousedown handler.
    this.urlbar.addEventListener("blur", () => setTimeout(() => this.hideSuggest(), 120));

    // Nav row: back / forward / reload buttons sit left of the URL bar.
    const navrow = document.createElement("div");
    Object.assign(navrow.style, {
      flex: "0 0 auto",
      display: "flex",
      alignItems: "center",
      gap: "4px",
      padding: "5px 6px",
      background: "#2a2a2a",
    } satisfies Partial<CSSStyleDeclaration>);
    // onHold (optional): a long-press or right-click opens a menu instead of the
    // plain click action — Chrome's press-and-hold-the-back-button history list.
    const mkBtn = (glyph: string, title: string, on: () => void, onHold?: (b: HTMLButtonElement) => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = glyph;
      b.title = title;
      Object.assign(b.style, {
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "30px",
        height: "30px",
        padding: "0",
        borderRadius: "6px",
        border: "1px solid #4a4a4a",
        outline: "none",
        background: "#383838",
        color: "#eee",
        font: "18px/1 system-ui, sans-serif",
        cursor: "pointer",
      } satisfies Partial<CSSStyleDeclaration>);
      let holdTimer = 0;
      let held = false;
      // Don't let a button click steal focus from / blur the page selection.
      b.addEventListener("mousedown", (e) => {
        e.preventDefault();
        if (!onHold || b.disabled) return;
        held = false;
        holdTimer = window.setTimeout(() => { held = true; onHold(b); }, 350);
      });
      const clearHold = () => clearTimeout(holdTimer);
      b.addEventListener("mouseup", clearHold);
      b.addEventListener("mouseleave", () => { clearHold(); b.style.background = "#383838"; });
      b.addEventListener("mouseenter", () => { if (!b.disabled) b.style.background = "#4a4a4a"; });
      b.addEventListener("contextmenu", (e) => {
        if (!onHold || b.disabled) return;
        e.preventDefault();
        held = true; // also suppress the trailing click
        onHold(b);
      });
      b.addEventListener("click", () => {
        if (held) { held = false; return; } // a hold/right-click already acted
        on();
        this.canvas.focus();
      });
      return b;
    };
    this.backBtn = mkBtn("←", "Back", () => this.goBack(), (b) => this.showHistMenu(b, -1));
    this.fwdBtn = mkBtn("→", "Forward", () => this.goForward(), (b) => this.showHistMenu(b, 1));
    const reloadBtn = mkBtn("⟳", "Reload", () => this.reload());
    Object.assign(this.urlbar.style, {
      flex: "1 1 auto",
      width: "100%",
      height: "30px",
      borderRadius: "6px",
      padding: "0 12px",
      fontSize: "13px",
    } satisfies Partial<CSSStyleDeclaration>);
    // Wrap the bar so the suggestion dropdown can anchor under it.
    const urlWrap = document.createElement("div");
    Object.assign(urlWrap.style, {
      position: "relative",
      flex: "1 1 auto",
      display: "flex",
    } satisfies Partial<CSSStyleDeclaration>);
    this.suggestBox = document.createElement("div");
    Object.assign(this.suggestBox.style, {
      position: "absolute",
      top: "calc(100% + 4px)",
      left: "0",
      right: "0",
      zIndex: "20",
      display: "none",
      flexDirection: "column",
      maxHeight: "320px",
      overflowY: "auto",
      background: "#2a2a2a",
      border: "1px solid #4a4a4a",
      borderRadius: "6px",
      boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
    } satisfies Partial<CSSStyleDeclaration>);
    urlWrap.append(this.urlbar, this.suggestBox);
    navrow.append(this.backBtn, this.fwdBtn, reloadBtn, urlWrap);
    this.updateNavButtons();

    // Back/forward history menu (Chrome's press-and-hold list), anchored under
    // whichever button opened it. Absolutely positioned inside the view root.
    this.histMenu = document.createElement("div");
    Object.assign(this.histMenu.style, {
      position: "absolute",
      zIndex: "30",
      display: "none",
      flexDirection: "column",
      minWidth: "260px",
      maxWidth: "440px",
      maxHeight: "360px",
      overflowY: "auto",
      background: "#2a2a2a",
      border: "1px solid #4a4a4a",
      borderRadius: "6px",
      boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
      font: "12px system-ui, sans-serif",
    } satisfies Partial<CSSStyleDeclaration>);

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

    this.el.append(navrow, this.canvas, this.histMenu);
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    host.appendChild(this.el);

    this.wireInput();
    this.ro = new ResizeObserver(() => this.scheduleResize());
    this.ro.observe(this.canvas);
    // display:none (dockview hides inactive panels) leaves the canvas with no box,
    // so it stops intersecting — that's our "tab hidden" signal.
    this.io = new IntersectionObserver((ents) => {
      this.inViewport = ents[ents.length - 1].isIntersecting;
      this.syncStreaming();
    });
    this.io.observe(this.canvas);
    document.addEventListener("visibilitychange", this.onVisibility);

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
  // Performance mode pins dpr to 1 so the screencast renders at CSS resolution
  // (far fewer pixels per frame on a retina display).
  private metrics() {
    const r = this.canvas.getBoundingClientRect();
    return {
      width: Math.max(1, Math.round(r.width)),
      height: Math.max(1, Math.round(r.height)),
      dpr: cdpPerf() ? 1 : window.devicePixelRatio || 1,
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
    if (!d) return;
    const seq = ++this.drawSeq;
    // Base64 → bytes on the main thread (cheap), then createImageBitmap does the
    // JPEG decode off-thread and returns a directly-drawable bitmap — no <img>
    // data-URL load round-trip. Skip atob via a manual loop (no fetch, so no CSP
    // worries with data: URLs).
    const bin = atob(d);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    createImageBitmap(new Blob([bytes], { type: "image/jpeg" }))
      .then((bmp) => {
        if (seq !== this.drawSeq) { bmp.close(); return; } // a newer frame already won
        if (this.canvas.width !== bmp.width || this.canvas.height !== bmp.height) {
          this.canvas.width = bmp.width;
          this.canvas.height = bmp.height;
        }
        this.ctx.drawImage(bmp, 0, 0);
        bmp.close();
      })
      .catch(() => {});
  }

  private onVisibility = () => this.syncStreaming();

  // Stop the screencast when the tab is hidden (off-screen panel or hidden
  // document) and restart it when it comes back. Visibility is recomputed from
  // live state every call — never cached as the gate for applyMetrics — so a
  // stale IntersectionObserver reading can't wedge the stream off (the bug where
  // resize + video froze after toggling perf). Resume goes through scheduleResize
  // so it coalesces with the ResizeObserver tick a show also produces.
  private syncStreaming() {
    const visible = this.inViewport && !document.hidden;
    if (visible && this.paused) {
      this.paused = false;
      this.scheduleResize();
    } else if (!visible && !this.paused) {
      this.paused = true;
      invoke("cdp_send", { id: this.id, method: "Page.stopScreencast", params: {} }).catch(console.error);
    }
  }

  private scheduleResize() {
    clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => this.applyMetrics(), 120);
  }

  /** Push current size + the active quality to the screencast (restarts it). */
  applyMetrics() {
    const m = this.metrics();
    // No layout box (hidden panel reports 0×0): don't restart at 1×1. When the
    // panel is shown again its ResizeObserver fires with the real size and we
    // restart then — this is the only gate, so the stream always recovers.
    if (m.width <= 1 || m.height <= 1) return;
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
    if (this.pendingTarget !== null) {
      this.idx = Math.max(0, Math.min(this.urls.length - 1, this.pendingTarget));
      this.pendingTarget = null;
      this.pendingNav = 0;
    } else if (this.pendingNav === -1) {
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

  // Jump straight to a history entry (the back/forward menu). history.go(delta)
  // walks the page's own session history in one hop; onNavigated lands idx there.
  private jumpTo(target: number) {
    const t = Math.max(0, Math.min(this.urls.length - 1, target));
    if (t === this.idx) return;
    this.pendingTarget = t;
    this.closeHistMenu();
    this.evalJs(`history.go(${t - this.idx})`);
  }

  // Chrome-style press-and-hold (or right-click) history list. dir = -1 lists the
  // back entries (most-recent first), dir = +1 the forward entries.
  private showHistMenu(anchor: HTMLButtonElement, dir: -1 | 1) {
    const items: { url: string; target: number }[] = [];
    if (dir === -1) for (let i = this.idx - 1; i >= 0; i--) items.push({ url: this.urls[i], target: i });
    else for (let i = this.idx + 1; i < this.urls.length; i++) items.push({ url: this.urls[i], target: i });
    if (items.length === 0) return;

    const menu = this.histMenu;
    menu.replaceChildren();
    for (const { url, target } of items) {
      const row = document.createElement("div");
      Object.assign(row.style, {
        padding: "7px 12px",
        color: "#ddd",
        cursor: "pointer",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      } satisfies Partial<CSSStyleDeclaration>);
      row.textContent = this.histLabel(url);
      row.title = url;
      row.addEventListener("mouseenter", () => { row.style.background = "#3b6ea5"; row.style.color = "#fff"; });
      row.addEventListener("mouseleave", () => { row.style.background = "transparent"; row.style.color = "#ddd"; });
      row.addEventListener("mousedown", (e) => { e.preventDefault(); this.jumpTo(target); });
      menu.appendChild(row);
    }
    // Anchor under the button, clamped to the view's left edge.
    const br = anchor.getBoundingClientRect();
    const er = this.el.getBoundingClientRect();
    menu.style.left = `${Math.max(0, br.left - er.left)}px`;
    menu.style.top = `${br.bottom - er.top + 4}px`;
    menu.style.display = "flex";
    // Close on the next outside pointerdown (capture so it beats other handlers).
    setTimeout(() => window.addEventListener("pointerdown", this.onHistOutside, true), 0);
  }

  private onHistOutside = (e: PointerEvent) => {
    if (!this.histMenu.contains(e.target as Node)) this.closeHistMenu();
  };

  private closeHistMenu() {
    this.histMenu.style.display = "none";
    window.removeEventListener("pointerdown", this.onHistOutside, true);
  }

  // Compact label for a history row: host + truncated path, no scheme.
  private histLabel(url: string): string {
    try {
      const u = new URL(url);
      const path = (u.pathname + u.search).replace(/^\/$/, "");
      return u.host + (path.length > 48 ? path.slice(0, 48) + "…" : path);
    } catch {
      return url;
    }
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

  // Navigate to a typed string (URL or search) or a chosen suggestion, then drop
  // focus back to the page. Empty input is a no-op.
  private navigateTo(raw: string) {
    const u = this.normalizeUrl(raw.trim());
    this.hideSuggest();
    if (u) invoke("cdp_navigate", { id: this.id, url: u }).catch(console.error);
    this.canvas.focus();
  }

  // Compute the suggestion list for the current input: recent history when empty
  // (temporal), fuzzy matches over history otherwise. Capped at 8.
  private openSuggest() {
    const q = this.urlbar.value.trim();
    const urls = navHistory().map((e) => e.url);
    const items = (q ? fuzzyFilter(q, urls, (u) => u) : urls).slice(0, 8);
    this.suggestions = items;
    this.suggestIdx = -1;
    this.renderSuggest();
  }

  private hideSuggest() {
    this.suggestBox.style.display = "none";
    this.suggestIdx = -1;
  }

  private renderSuggest() {
    const box = this.suggestBox;
    box.replaceChildren();
    if (this.suggestions.length === 0) {
      box.style.display = "none";
      return;
    }
    this.suggestions.forEach((url, i) => {
      const row = document.createElement("div");
      row.dataset.i = String(i);
      Object.assign(row.style, {
        padding: "6px 12px",
        fontSize: "12px",
        color: "#ddd",
        cursor: "pointer",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      } satisfies Partial<CSSStyleDeclaration>);
      row.textContent = url;
      // mousedown (not click): fires before the input's blur, so the choice
      // registers before the dropdown would otherwise close.
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.navigateTo(url);
      });
      row.addEventListener("mouseenter", () => {
        this.suggestIdx = i;
        this.highlightSuggest();
      });
      box.appendChild(row);
    });
    box.style.display = "flex";
    this.highlightSuggest();
  }

  private moveSuggest(delta: number) {
    if (this.suggestions.length === 0) return;
    if (this.suggestBox.style.display === "none") this.renderSuggest();
    const n = this.suggestions.length;
    // Wrap, with -1 (input text) as a stop above the first row.
    this.suggestIdx = this.suggestIdx + delta;
    if (this.suggestIdx < -1) this.suggestIdx = n - 1;
    if (this.suggestIdx >= n) this.suggestIdx = -1;
    this.highlightSuggest();
  }

  private highlightSuggest() {
    for (const child of Array.from(this.suggestBox.children)) {
      const el = child as HTMLElement;
      const on = Number(el.dataset.i) === this.suggestIdx;
      el.style.background = on ? "#3b6ea5" : "transparent";
      el.style.color = on ? "#fff" : "#ddd";
    }
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
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("pointerdown", this.onHistOutside, true);
    this.io?.disconnect();
    this.ro.disconnect();
    this.unlisten?.();
    this.unlistenCursor?.();
    this.unlistenUrl?.();
    this.unlistenCopy?.();
    this.el.remove();
  }
}
// todo(boundary): isolate CDP commands and events behind a browser-engine port
// todo(split): separate screencast rendering, input translation, and navigation state
