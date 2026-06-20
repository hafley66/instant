import "xp.css";
import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { store, type AppState, type Skin } from "./state";

type Session = { name: string; windows: number; attached: boolean };

type Tab = {
  id: string;
  name: string;
  term: Terminal;
  fit: FitAddon;
  el: HTMLElement;
};

// Runtime registry of live terminals. These are resources, not serializable app
// state, so they stay out of the store; the active tab *id* lives in the store.
const tabs = new Map<string, Tab>();

const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
const terminalsEl = $("#terminals");
const tabsEl = $("#tabs");
const listEl = $("#session-list") as HTMLUListElement;

const sessionId = (name: string) => `s:${name}`;
const activeId = () => store.get().active;
const setActive = (id: string | null) => store.set({ active: id });

// xterm palettes per skin. XP = classic console; P5 = blood-red on black.
const THEMES: Record<Skin, { background: string; foreground: string; cursor: string }> = {
  xp: { background: "#000000", foreground: "#c0c0c0", cursor: "#ffffff" },
  p5: { background: "#0a0000", foreground: "#ff2b2b", cursor: "#ff2b2b" },
};

// Quick-start sessions launch their agent the first time the tmux session is created.
const QUICK_CMD: Record<string, string> = {
  claude: "claude",
  opencode: "opencode",
};

function openTab(name: string) {
  const id = sessionId(name);
  if (tabs.has(id)) {
    activate(id);
    return;
  }

  const el = document.createElement("div");
  el.className = "term-host";
  terminalsEl.appendChild(el);

  const term = new Terminal({
    fontFamily: "Menlo, monospace",
    fontSize: 13,
    cursorBlink: true,
    allowProposedApi: true,
    theme: THEMES[store.get().skin],
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);

  tabs.set(id, { id, name, term, fit, el });

  term.onData((data) => invoke("write_pty", { id, data }).catch(console.error));
  term.onResize(({ cols, rows }) =>
    invoke("resize_pty", { id, cols, rows }).catch(console.error),
  );

  // Fit AFTER layout so the pty spawns at the real grid size, not the pre-layout
  // 80x24 default that leaves full-screen TUIs (opencode) clipped.
  const command = QUICK_CMD[name] ?? null;
  requestAnimationFrame(() => {
    fit.fit();
    const { cols, rows } = term;
    invoke("open_session", { id, name, command, cols, rows }).catch(console.error);
  });

  renderTabs();
  activate(id);
}

function activate(id: string) {
  setActive(id);
  for (const [tid, t] of tabs) {
    t.el.style.display = tid === id ? "block" : "none";
  }
  const t = tabs.get(id);
  if (t) {
    requestAnimationFrame(() => {
      t.fit.fit();
      invoke("resize_pty", { id, cols: t.term.cols, rows: t.term.rows }).catch(
        () => {},
      );
      t.term.focus();
    });
  }
  renderTabs();
  renderSessionActive();
}

function closeTab(id: string) {
  const t = tabs.get(id);
  if (!t) return;
  invoke("close_pty", { id }).catch(() => {}); // tmux session keeps running
  t.term.dispose();
  t.el.remove();
  tabs.delete(id);
  if (activeId() === id) {
    const next = tabs.keys().next();
    const nextId = next.done ? null : next.value;
    setActive(nextId);
    if (nextId) activate(nextId);
  }
  renderTabs();
}

function renderTabs() {
  tabsEl.innerHTML = "";
  for (const [id, t] of tabs) {
    const b = document.createElement("button");
    b.className = "tab" + (id === activeId() ? " tab-active" : "");
    b.textContent = t.name;
    b.onclick = () => activate(id);
    const x = document.createElement("span");
    x.className = "tab-close";
    x.textContent = "×";
    x.onclick = (e) => {
      e.stopPropagation();
      closeTab(id);
    };
    b.appendChild(x);
    tabsEl.appendChild(b);
  }
}

function renderSessionActive() {
  listEl.querySelectorAll("li").forEach((li) => {
    const id = (li as HTMLLIElement).dataset.id;
    li.classList.toggle("active", !!id && id === activeId());
  });
}

async function refreshSessions() {
  let live: Session[] = [];
  try {
    live = await invoke<Session[]>("list_sessions");
  } catch (e) {
    console.error(e);
  }

  // Quick-starts always offered; if a tmux session of that name exists it merges.
  const quick = ["claude", "opencode"];
  const names = new Set<string>(quick);
  for (const s of live) names.add(s.name);

  const byName = new Map(live.map((s) => [s.name, s]));

  listEl.innerHTML = "";
  for (const name of names) {
    const s = byName.get(name);
    const li = document.createElement("li");
    li.dataset.id = sessionId(name);
    li.className = "session";
    li.innerHTML = `<span class="dot ${s?.attached ? "on" : ""}"></span>
      <span class="s-name">${name}</span>
      <span class="s-meta">${s ? `${s.windows}w` : "new"}</span>`;
    li.onclick = () => openTab(name);
    listEl.appendChild(li);
  }
  renderSessionActive();
}

// ---- store-driven view sync: skin and mode push to the DOM + controls ----
function syncSkin(s: AppState) {
  document.body.dataset.skin = s.skin;
  ($("#skin-toggle") as HTMLButtonElement).textContent =
    s.skin === "xp" ? "P5" : "XP";
  for (const t of tabs.values()) {
    t.term.options.theme = THEMES[s.skin];
    t.fit.fit();
  }
}
function syncMode(s: AppState) {
  document.body.dataset.mode = s.mode;
  ($("#mode-toggle") as HTMLButtonElement).textContent =
    s.mode === "dark" ? "☀" : "☾";
}

// While true, the blur-to-hide handler stands down (the screenshot crosshair
// steals focus, which would otherwise hide us mid-capture).
let capturing = false;

// Blur-to-hide is deferred, not immediate: dragging a file in from Finder blurs
// us (the source app goes active), and an immediate hide would vanish the window
// before the drop lands. The pending hide is cancelled when a drag enters or
// focus returns.
let hideTimer: number | undefined;
function cancelHide() {
  if (hideTimer !== undefined) {
    clearTimeout(hideTimer);
    hideTimer = undefined;
  }
}

// Hide the popover, let the user crosshair-select a region, then type the saved
// PNG path into the active terminal so claude/opencode can read the image.
async function captureToPrompt() {
  const id = activeId();
  const win = getCurrentWindow();
  capturing = true;
  await win.hide();
  let path: string | null = null;
  try {
    path = await invoke<string>("screenshot");
  } catch (e) {
    console.error("screenshot:", e); // Esc, or no Screen Recording permission
  }
  await win.show();
  await win.setFocus();
  // Keep the blur guard up briefly so the focus settling after show() doesn't
  // immediately trip click-outside-to-hide.
  setTimeout(() => (capturing = false), 300);
  if (path && id) {
    await invoke("write_pty", { id, data: path + " " }).catch(console.error);
    tabs.get(id)?.term.focus();
  }
}

// Drag an image (or any file) onto the window -> drop its path into the active
// terminal, same idea as the screenshot button but without hiding the window.
function pathArg(p: string): string {
  return /\s/.test(p) ? `'${p.replace(/'/g, "'\\''")}'` : p;
}
async function wireDragDrop() {
  await getCurrentWebview().onDragDropEvent((e) => {
    // Any drag activity over the window means a drop may be coming; keep us up.
    cancelHide();
    if (e.payload.type !== "drop") return;
    const id = activeId();
    if (!id || !e.payload.paths.length) return;
    const data = e.payload.paths.map(pathArg).join(" ") + " ";
    invoke("write_pty", { id, data }).catch(console.error);
    tabs.get(id)?.term.focus();
  });
}

function wireChrome() {
  $("#skin-toggle").onclick = () =>
    store.set({ skin: store.get().skin === "xp" ? "p5" : "xp" });

  $("#mode-toggle").onclick = () =>
    store.set({ mode: store.get().mode === "dark" ? "light" : "dark" });

  $("#shot-btn").onclick = captureToPrompt;

  $("#min-btn").onclick = () => getCurrentWindow().minimize();
  $("#max-btn").onclick = () => getCurrentWindow().toggleMaximize();
  $("#hide-btn").onclick = () => getCurrentWindow().hide();

  $("#new-session").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#new-name") as HTMLInputElement;
    const name = input.value.trim();
    if (!name) return;
    input.value = "";
    openTab(name);
    refreshSessions();
  });
}

async function main() {
  // Skin/mode are store-driven: subscribe for changes, then apply once for the
  // persisted initial state.
  store.subscribe(syncSkin, ["skin"]);
  store.subscribe(syncMode, ["mode"]);
  syncSkin(store.get());
  syncMode(store.get());

  wireChrome();
  wireDragDrop();
  await refreshSessions();

  await listen<{ id: string; chunk: string }>("pty-data", (e) => {
    tabs.get(e.payload.id)?.term.write(e.payload.chunk);
  });

  // Summon: replay entrance animation + refocus active terminal.
  await listen("summoned", () => {
    const app = $("#app");
    app.classList.remove("summon-in");
    void app.offsetWidth; // restart the CSS animation
    app.classList.add("summon-in");
    refreshSessions();
    // Window may reappear at a new size/position; refit so the grid (and the
    // tmux pane behind it) matches, otherwise the TUI draws clipped.
    const id = activeId();
    if (id) {
      const t = tabs.get(id);
      requestAnimationFrame(() => {
        t?.fit.fit();
        t?.term.focus();
      });
    }
  });

  new ResizeObserver(() => {
    const id = activeId();
    if (id) tabs.get(id)?.fit.fit();
  }).observe(terminalsEl);

  // Esc hides the popover.
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") getCurrentWindow().hide();
  });

  // Click-outside dismiss: hide when the window loses focus. Gated on a prior
  // focus so it doesn't self-hide at launch, and suppressed during screenshot.
  const win = getCurrentWindow();
  let everFocused = false;
  await win.onFocusChanged(({ payload: focused }) => {
    if (focused) {
      everFocused = true;
      cancelHide();
      return;
    }
    if (everFocused && !capturing) {
      // Defer so a drag-in (which blurs us) can land; a drag-enter cancels it.
      cancelHide();
      hideTimer = window.setTimeout(() => win.hide(), 500);
    }
  });
}

main();
