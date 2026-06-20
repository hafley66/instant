import "xp.css";
import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  store,
  type AppState,
  type Skin,
  type Workspace,
  type WorktreeRow,
} from "./state";

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
const wsListEl = $("#workspace-list") as HTMLUListElement;

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

// opts let a Space override the agent command and launch cwd; plain sessions
// fall back to QUICK_CMD and the backend default (HOME).
function openTab(name: string, opts: { command?: string | null; cwd?: string | null } = {}) {
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
  const command = opts.command ?? QUICK_CMD[name] ?? null;
  const cwd = opts.cwd ?? null;
  requestAnimationFrame(() => {
    fit.fit();
    const { cols, rows } = term;
    invoke("open_session", { id, name, command, cwd, cols, rows }).catch(console.error);
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
  document.querySelectorAll<HTMLLIElement>(".sidebar-lists li").forEach((li) => {
    const id = li.dataset.id;
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

// ---- workspaces (Spaces): a git worktree + agent, opened in its own cwd ----
function renderWorkspaces(list: Workspace[]) {
  wsListEl.innerHTML = "";
  for (const ws of list) {
    const li = document.createElement("li");
    li.className = "session";
    li.dataset.id = sessionId(ws.id);
    li.innerHTML = `<span class="dot on"></span>
      <span class="s-name">${ws.id}</span>
      <span class="s-meta">${ws.agent}</span>`;
    li.onclick = () => openTab(ws.id, { command: ws.agent, cwd: ws.path });
    const rm = document.createElement("span");
    rm.className = "tab-close";
    rm.textContent = "×";
    rm.title = "remove space (keeps the worktree on disk)";
    rm.onclick = (e) => {
      e.stopPropagation();
      invoke("remove_workspace", { id: ws.id, deleteTree: false }).catch(
        console.error,
      ); // workspaces-changed refreshes the list
    };
    li.appendChild(rm);
    wsListEl.appendChild(li);
  }
  renderSessionActive();
}

async function refreshWorkspaces() {
  try {
    store.set({ workspaces: await invoke<Workspace[]>("list_workspaces") });
  } catch (e) {
    console.error(e);
  }
}

// ---- worktrees table: discover existing worktrees across N repo clones ----
const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const tmuxName = (s: string) => s.replace(/[.:\s]/g, "-");

// "git@github.com:org/repo.git" / "https://host/org/repo.git" -> "org/repo"
function prettyOrigin(url: string): string {
  if (!url) return "(no remote)";
  const s = url
    .replace(/^git@/, "")
    .replace(/^https?:\/\//, "")
    .replace(/\.git$/, "")
    .replace(":", "/");
  return s.split("/").filter(Boolean).slice(-2).join("/") || s;
}

function renderWorktrees(rows: WorktreeRow[]) {
  const host = $("#wt-table");
  host.innerHTML = "";
  ($("#wt-count") as HTMLElement).textContent = rows.length
    ? `${rows.length} worktrees`
    : "";

  // Group by origin so the N-clones-of-one-repo structure is visible.
  const byOrigin = new Map<string, WorktreeRow[]>();
  for (const r of rows) {
    const key = r.origin || "(no remote)";
    (byOrigin.get(key) ?? byOrigin.set(key, []).get(key)!).push(r);
  }

  const table = document.createElement("table");
  table.className = "dtable";
  table.innerHTML =
    "<thead><tr><th>branch</th><th>clone › worktree</th><th>head</th><th></th></tr></thead>";
  const tbody = document.createElement("tbody");

  for (const [origin, group] of byOrigin) {
    group.sort((a, b) => a.clone.localeCompare(b.clone) || (b.is_main ? 1 : 0) - (a.is_main ? 1 : 0));
    const clones = new Set(group.map((r) => r.clone)).size;
    const gh = document.createElement("tr");
    gh.className = "dtable-group";
    if (clones > 1) gh.classList.add("multi"); // highlight the actual dupes
    const gtd = document.createElement("td");
    gtd.colSpan = 4;
    const count =
      clones > 1
        ? `${clones} clones · ${group.length} worktrees`
        : group.length > 1
          ? `${group.length} worktrees`
          : "";
    gtd.textContent = count ? `${prettyOrigin(origin)}   ·   ${count}` : prettyOrigin(origin);
    gh.title = origin;
    gh.appendChild(gtd);
    tbody.appendChild(gh);

    for (const r of group) {
      const tr = document.createElement("tr");
      tr.className = "dtable-row";
      const loc = `${baseName(r.clone)} › ${r.is_main ? "(main)" : baseName(r.worktree)}`;
      const cells = [
        r.branch,
        loc,
        r.head,
        r.dirty ? "●" : "",
      ];
      cells.forEach((c, i) => {
        const td = document.createElement("td");
        td.textContent = c;
        if (i === 3 && r.dirty) td.className = "wt-dirty";
        tr.appendChild(td);
      });
      tr.title = r.worktree + (r.dirty ? "  (uncommitted changes)" : "");
      tr.onclick = () => {
        openTab(tmuxName(`${baseName(r.clone)}-${r.branch}`), { cwd: r.worktree });
        store.set({ panel: "terminal" });
      };
      tbody.appendChild(tr);
    }
  }
  table.appendChild(tbody);
  host.appendChild(table);
}

async function scanWorktrees() {
  const root = ($("#wt-root") as HTMLInputElement).value.trim();
  ($("#wt-count") as HTMLElement).textContent = "scanning…";
  try {
    const rows = await invoke<WorktreeRow[]>("scan_worktrees", {
      roots: root ? [root] : [],
      maxDepth: null,
    });
    store.set({ worktrees: rows });
  } catch (e) {
    console.error("scan_worktrees:", e);
    ($("#wt-count") as HTMLElement).textContent = "scan failed";
  }
}

function syncPanel(s: AppState) {
  document.body.dataset.panel = s.panel;
  ($("#wt-toggle") as HTMLButtonElement).classList.toggle(
    "active",
    s.panel === "worktrees",
  );
  // Lazy first scan when the table is opened empty.
  if (s.panel === "worktrees" && store.get().worktrees.length === 0) scanWorktrees();
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

  $("#wt-toggle").onclick = () =>
    store.set({
      panel: store.get().panel === "worktrees" ? "terminal" : "worktrees",
    });
  $("#wt-scan").addEventListener("submit", (e) => {
    e.preventDefault();
    scanWorktrees();
  });

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

  $("#new-workspace").addEventListener("submit", (e) => {
    e.preventDefault();
    const repoEl = $("#ws-repo") as HTMLInputElement;
    const branchEl = $("#ws-branch") as HTMLInputElement;
    const repo = repoEl.value.trim();
    const branch = branchEl.value.trim();
    const agent = ($("#ws-agent") as HTMLSelectElement).value;
    if (!repo || !branch) return;
    invoke<Workspace>("create_workspace", { repo, branch, agent })
      .then((ws) => {
        repoEl.value = "";
        branchEl.value = "";
        openTab(ws.id, { command: ws.agent, cwd: ws.path });
      })
      .catch((err) => console.error("create_workspace:", err));
  });
}

async function main() {
  // Skin/mode are store-driven: subscribe for changes, then apply once for the
  // persisted initial state.
  store.subscribe(syncSkin, ["skin"]);
  store.subscribe(syncMode, ["mode"]);
  store.subscribe(syncPanel, ["panel"]);
  store.subscribe((s) => renderWorkspaces(s.workspaces), ["workspaces"]);
  store.subscribe((s) => renderWorktrees(s.worktrees), ["worktrees"]);
  syncSkin(store.get());
  syncMode(store.get());
  syncPanel(store.get());

  wireChrome();
  wireDragDrop();
  await refreshSessions();
  await refreshWorkspaces();

  await listen<{ id: string; chunk: string }>("pty-data", (e) => {
    tabs.get(e.payload.id)?.term.write(e.payload.chunk);
  });

  // Backend pushes the registry whenever a Space is created/removed.
  await listen<Workspace[]>("workspaces-changed", (e) => {
    store.set({ workspaces: e.payload });
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
