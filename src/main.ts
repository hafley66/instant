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
  type ActivitySource,
  type ActivityType,
  type AppState,
  type ConfigView,
  type DirListing,
  type Event,
  type FsEntry,
  type PanelId,
  type Skin,
  type Workspace,
  type WorktreeRow,
} from "./state";
import { renderTable } from "./table";
import { fuzzyFilter } from "./fuzzy";
import { wireContextMenu, type CtxItem } from "./ctxmenu";
import {
  mountReactDock,
  togglePanel,
  isOpen,
  setDockHooks,
  onDockChange,
} from "./Dock";

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

// Persisted open-tab list (for reattach after reload). Keyed by tab name.
function recordTab(name: string, command: string | null, cwd: string | null) {
  const cur = store.get().openTabs;
  if (cur.some((t) => t.name === name)) return;
  store.set({ openTabs: [...cur, { name, command, cwd }] });
}
function forgetTab(id: string) {
  store.set({ openTabs: store.get().openTabs.filter((t) => sessionId(t.name) !== id) });
}

// Browser-like history of which session you went to and when. Logged into the
// unified activity store (source='session'), deduped on consecutive same-tab,
// suppressed during boot replay so restoring tabs doesn't spam the timeline.
let replaying = false;
let lastVisited: string | null = null;
function logTabVisit(name: string) {
  if (replaying || name === lastVisited) return;
  lastVisited = name;
  invoke("activity_log", {
    source: "session",
    kind: "focus",
    title: name,
    text: `went to ${name}`,
  }).catch(() => {});
}

// xterm palettes per skin. XP = classic console; P5 = blood-red on black;
// AC3 = phosphor-green garage readout with an orange cursor.
const THEMES: Record<Skin, { background: string; foreground: string; cursor: string }> = {
  xp: { background: "#000000", foreground: "#c0c0c0", cursor: "#ffffff" },
  p5: { background: "#0a0000", foreground: "#ff2b2b", cursor: "#ff2b2b" },
  ac3: { background: "#050805", foreground: "#b8e08a", cursor: "#ff8c1a" },
};

// Skin cycle order for the toolbar toggle (XP -> P5 -> AC3 -> XP).
const SKIN_CYCLE: Skin[] = ["xp", "p5", "ac3"];
const nextSkin = (s: Skin): Skin =>
  SKIN_CYCLE[(SKIN_CYCLE.indexOf(s) + 1) % SKIN_CYCLE.length];

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

  // iTerm2-style word/line editing. xterm doesn't emit these by default on mac,
  // so we intercept and write the readline/emacs control sequences the shell
  // (and claude/opencode) understand. Returning false stops xterm's own handling
  // (e.g. Alt+b inserting "∫").
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    const send = (data: string) => {
      invoke("write_pty", { id, data }).catch(console.error);
      return false;
    };
    const only = (a: boolean, b: boolean, c: boolean) => a && !b && !c;
    if (only(e.altKey, e.metaKey, e.ctrlKey)) {
      if (e.key === "ArrowLeft") return send("\x1bb"); // word back
      if (e.key === "ArrowRight") return send("\x1bf"); // word forward
      if (e.key === "Backspace") return send("\x1b\x7f"); // delete word back
    }
    if (only(e.metaKey, e.altKey, e.ctrlKey)) {
      if (e.key === "ArrowLeft") return send("\x01"); // line start (Ctrl-A)
      if (e.key === "ArrowRight") return send("\x05"); // line end (Ctrl-E)
      if (e.key === "Backspace") return send("\x15"); // kill to line start (Ctrl-U)
    }
    return true;
  });

  // Fit AFTER layout so the pty spawns at the real grid size, not the pre-layout
  // 80x24 default that leaves full-screen TUIs (opencode) clipped.
  const command = opts.command ?? QUICK_CMD[name] ?? null;
  const cwd = opts.cwd ?? null;
  recordTab(name, command, cwd); // survives reload; tmux session outlives the webview
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
    logTabVisit(t.name);
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
  forgetTab(id); // don't reattach a tab the user closed
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

// The sidebar SESSIONS list mirrors the live tmux sessions (the real running
// shells/agents), not a creator. Click a row to attach/resume it into a tab;
// launching new ones is the job of the quick-launch buttons + new-shell input.
async function refreshSessions() {
  let live: Session[] = [];
  try {
    live = await invoke<Session[]>("list_sessions");
  } catch (e) {
    console.error(e);
  }

  ($("#session-count") as HTMLElement).textContent = live.length
    ? String(live.length)
    : "";

  listEl.innerHTML = "";
  if (live.length === 0) {
    const li = document.createElement("li");
    li.className = "session-empty";
    li.textContent = "no live sessions — launch one below";
    listEl.appendChild(li);
  }
  for (const s of live) {
    const open = tabs.has(sessionId(s.name));
    const li = document.createElement("li");
    li.dataset.id = sessionId(s.name);
    li.className = "session";
    li.innerHTML = `<span class="dot ${s.attached ? "on" : ""}"></span>
      <span class="s-name">${s.name}</span>
      <span class="s-meta">${s.windows}w${open ? " · open" : ""}</span>`;
    li.onclick = () => openTab(s.name); // attaches (tmux new-session -A) / focuses
    const kill = document.createElement("span");
    kill.className = "tab-close";
    kill.textContent = "×";
    kill.title = "kill this tmux session";
    kill.onclick = (e) => {
      e.stopPropagation();
      const id = sessionId(s.name);
      if (tabs.has(id)) {
        // closeTab also forgets + disposes the tab; then kill the tmux session.
        const t = tabs.get(id)!;
        t.term.dispose();
        t.el.remove();
        tabs.delete(id);
        forgetTab(id);
        if (activeId() === id) {
          const next = tabs.keys().next();
          setActive(next.done ? null : next.value);
          if (!next.done) activate(next.value);
        }
        renderTabs();
      }
      invoke("kill_session", { name: s.name })
        .then(() => refreshSessions())
        .catch(console.error);
    };
    li.appendChild(kill);
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

// Two views over the same rows: a collapsible fs tree, and a flat table.
// Expanded node keys live in the (persisted) store.
type CloneNode = { clone: string; branch: string; worktrees: WorktreeRow[] };
type OrgNode = { origin: string; clones: CloneNode[] };

// org/repo -> clone (fs checkout + its branch) -> worktrees
function buildTree(rows: WorktreeRow[]): OrgNode[] {
  const orgs = new Map<string, Map<string, CloneNode>>();
  for (const r of rows) {
    const okey = r.origin || "(no remote)";
    let clones = orgs.get(okey);
    if (!clones) orgs.set(okey, (clones = new Map()));
    let cn = clones.get(r.clone);
    if (!cn) clones.set(r.clone, (cn = { clone: r.clone, branch: "", worktrees: [] }));
    cn.worktrees.push(r);
    if (r.is_main) cn.branch = r.branch;
  }
  return [...orgs.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([origin, clones]) => ({
      origin,
      clones: [...clones.values()].sort((a, b) => a.clone.localeCompare(b.clone)),
    }));
}

function openWorktree(clone: string, branch: string, wtPath: string) {
  // Terminal lives permanently in the center zone now, so just open the tab.
  openTab(tmuxName(`${baseName(clone)}-${branch}`), { cwd: wtPath });
}

function treeNode(opts: {
  depth: number;
  glyph: "+" | "-" | "";
  label: string;
  meta?: string;
  multi?: boolean;
  dirty?: boolean;
  onGlyph?: () => void;
  onLabel?: () => void;
}): HTMLElement {
  const row = document.createElement("div");
  row.className = "wt-node" + (opts.multi ? " multi" : "");
  row.style.paddingLeft = `${6 + opts.depth * 16}px`;

  const g = document.createElement("span");
  g.className = "wt-glyph";
  g.textContent = opts.glyph;
  if (opts.onGlyph)
    g.onclick = (e) => {
      e.stopPropagation();
      opts.onGlyph!();
    };
  row.appendChild(g);

  const label = document.createElement("span");
  label.className = "wt-label";
  label.textContent = opts.label;
  row.appendChild(label);

  if (opts.meta) {
    const m = document.createElement("span");
    m.className = "wt-meta";
    m.textContent = opts.meta;
    row.appendChild(m);
  }
  if (opts.dirty) {
    const d = document.createElement("span");
    d.className = "wt-dirty";
    d.textContent = "●";
    row.appendChild(d);
  }
  if (opts.onLabel) row.onclick = opts.onLabel;
  return row;
}

function renderTree(rows: WorktreeRow[]) {
  const host = $("#wt-table");
  host.innerHTML = "";
  const wtExpanded = new Set(store.get().wtExpanded);
  const toggle = (key: string) => {
    const next = new Set(wtExpanded);
    next.has(key) ? next.delete(key) : next.add(key);
    store.set({ wtExpanded: [...next] }); // persists + re-renders via subscription
  };

  const wrap = document.createElement("div");
  wrap.className = "wt-tree";
  for (const org of buildTree(rows)) {
    const okey = `o:${org.origin}`;
    const oOpen = wtExpanded.has(okey);
    wrap.appendChild(
      treeNode({
        depth: 0,
        glyph: oOpen ? "-" : "+",
        label: prettyOrigin(org.origin),
        meta: `${org.clones.length} clone${org.clones.length > 1 ? "s" : ""}`,
        multi: org.clones.length > 1,
        onGlyph: () => toggle(okey),
        onLabel: () => toggle(okey),
      }),
    );
    if (!oOpen) continue;

    for (const cl of org.clones) {
      const ckey = `${okey}|c:${cl.clone}`;
      const cOpen = wtExpanded.has(ckey);
      wrap.appendChild(
        treeNode({
          depth: 1,
          glyph: cl.worktrees.length ? (cOpen ? "-" : "+") : "",
          label: baseName(cl.clone),
          meta: cl.branch ? `@${cl.branch}` : "",
          onGlyph: cl.worktrees.length ? () => toggle(ckey) : undefined,
          onLabel: () => openWorktree(cl.clone, cl.branch, cl.clone),
        }),
      );
      if (!cOpen) continue;

      for (const wt of cl.worktrees) {
        wrap.appendChild(
          treeNode({
            depth: 2,
            glyph: "",
            label: wt.is_main ? "(main)" : baseName(wt.worktree),
            meta: `${wt.branch}  ${wt.head}`,
            dirty: wt.dirty,
            onLabel: () => openWorktree(cl.clone, wt.branch, wt.worktree),
          }),
        );
      }
    }
  }
  host.appendChild(wrap);
}

function renderFlatTable(rows: WorktreeRow[]) {
  const host = $("#wt-table");
  host.innerHTML = "";
  const sorted = [...rows].sort(
    (a, b) => a.origin.localeCompare(b.origin) || a.clone.localeCompare(b.clone),
  );
  host.appendChild(
    renderTable<WorktreeRow>({
      rows: sorted,
      columns: [
        { header: "org/repo", cell: (r) => prettyOrigin(r.origin) },
        { header: "clone", cell: (r) => baseName(r.clone) },
        { header: "worktree", cell: (r) => (r.is_main ? "(main)" : baseName(r.worktree)) },
        { header: "branch", cell: (r) => r.branch },
        { header: "head", cell: (r) => r.head },
        {
          header: "",
          cell: (r) => (r.dirty ? "●" : ""),
          cellClass: (r) => (r.dirty ? "wt-dirty" : undefined),
        },
      ],
      rowTitle: (r) => r.worktree,
      onRow: (r) => openWorktree(r.clone, r.branch, r.worktree),
    }),
  );
}

function renderWorktreesPanel() {
  const { worktrees, wtView } = store.get();
  ($("#wt-count") as HTMLElement).textContent = worktrees.length
    ? `${worktrees.length} worktrees`
    : "";
  ($("#wt-view") as HTMLButtonElement).textContent =
    wtView === "tree" ? "Table" : "Tree";
  if (wtView === "tree") renderTree(worktrees);
  else renderFlatTable(worktrees);
}

async function scanWorktrees() {
  const root = ($("#wt-root") as HTMLInputElement).value.trim();
  store.set({ scanRoot: root }); // remember it
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

// ---- activity: unified timeline of browser + os-capture + file events ----
const ACTIVITY_CAP = 2000;
const prettyUrl = (u: string) =>
  u.replace(/^https?:\/\//, "").replace(/^www\./, "");
function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Drop text into the active terminal (a row's text/url paste target).
function pasteToActive(data: string) {
  const id = activeId();
  if (!id || !data) return;
  invoke("write_pty", { id, data }).catch(console.error);
  tabs.get(id)?.term.focus();
}

// Where a row came from, for the source column: os captures show the frontmost
// app, browser rows the page title/host, file rows the file name.
function eventSource(e: Event): string {
  if (e.source === "os") return e.app || "screen";
  if (e.source === "files") return e.title || "file";
  return e.title || prettyUrl(e.url);
}
// The free-text payload fuzzy search runs over (and the search-key for a row).
function eventText(e: Event): string {
  return e.text || e.url || e.title;
}
function activityKey(e: Event): string {
  return `${e.kind} ${e.source} ${eventSource(e)} ${eventText(e)}`;
}

// Shown in the Activity panel before any event arrives: how to turn on capture
// and wire the extension (the ingest server is already running while up).
function activitySetupCard(): HTMLElement {
  const el = document.createElement("div");
  el.className = "empty-help";
  el.innerHTML = `
    <h3>activity — setup</h3>
    <p>A searchable history of what you touch: screen captures on mouse/key
       gestures, plus browser navigation/clicks and the files you open.</p>
    <p><b>Screen capture (OS):</b> flip <b>Recording</b> on (top-right of this
       panel). The first shot prompts for <b>Screen Recording</b> permission —
       grant it, then double-clicks, drags, and ⌘C/⌘V each save a screenshot
       tagged with the frontmost app. Default off; only ⌘C/⌘V keys are read.</p>
    <p><b>Browser:</b> the ingest server runs at <code>127.0.0.1:8787</code>
       while instant is open. Install the extension:</p>
    <ol>
      <li>Open <code>chrome://extensions</code></li>
      <li>Enable <b>Developer mode</b> (top-right)</li>
      <li><b>Load unpacked</b> → pick the <code>extension/</code> folder in the instant repo</li>
    </ol>
    <p>Click any row to paste its text/url into the active terminal; click a
       screenshot row to preview it. Search filters fzf-style.</p>
    <p class="muted">Test the browser ingest without Chrome:</p>
    <pre>curl -XPOST 127.0.0.1:8787/ingest \\
  -H 'content-type: application/json' \\
  -d '{"kind":"nav","url":"https://example.com","title":"Example"}'</pre>`;
  return el;
}

// Event-type sub-filters: cross-cut the source axis by what the event IS.
const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif|heic|tiff?)$/i;
const ACT_TYPE_MATCH: Record<ActivityType, (e: Event) => boolean> = {
  all: () => true,
  highlight: (e) => e.kind === "selection",
  clip: (e) => e.kind === "clipboard" || e.kind === "copy" || e.kind === "paste",
  // A screenshot, or any row pointing at an image file.
  image: (e) => !!e.shot || IMG_EXT.test(e.text) || IMG_EXT.test(e.title),
  file: (e) => e.source === "files" || e.kind === "open",
  url: (e) => e.kind === "nav" || e.kind.startsWith("tab") || (e.source === "browser" && !!e.url),
  click: (e) => e.kind === "click" || e.kind === "dblclick" || e.kind === "ctrlclick",
};

// The visible rows: source chip, then type chip, then fuzzy search box.
function visibleActivity(): Event[] {
  const { activity, activitySource, activityType, activityQuery } = store.get();
  const typeMatch = ACT_TYPE_MATCH[activityType];
  const filtered = activity.filter(
    (e) =>
      (activitySource === "all" || e.source === activitySource) && typeMatch(e),
  );
  return fuzzyFilter(activityQuery, filtered, activityKey);
}

let activitySelected: number | null = null; // selected row id (for the preview pane)

function renderActivityPanel() {
  const { activity, activitySource, activityType } = store.get();
  // Chips reflect the active filter. Use `.on` (not `.active`) — xp.css owns
  // button.active and would force the pressed-silver look over our color.
  document.querySelectorAll<HTMLButtonElement>(".act-chip[data-src]").forEach((b) => {
    b.classList.toggle("on", b.dataset.src === activitySource);
  });
  document.querySelectorAll<HTMLButtonElement>(".act-chip[data-type]").forEach((b) => {
    b.classList.toggle("on", b.dataset.type === activityType);
  });
  const rows = visibleActivity();
  ($("#activity-count") as HTMLElement).textContent = activity.length
    ? `${rows.length}/${activity.length}`
    : "";

  const host = $("#activity-table");
  host.innerHTML = "";
  if (activity.length === 0) {
    host.appendChild(activitySetupCard());
    renderActivityPreview();
    return;
  }
  host.appendChild(
    renderTable<Event>({
      rows,
      rowClass: (e) => (e.id === activitySelected ? "fs-selected" : undefined),
      columns: [
        { header: "time", cell: (e) => fmtTime(e.ts) },
        { header: "src", cell: (e) => e.source },
        { header: "kind", cell: (e) => e.kind },
        { header: "where", cell: (e) => eventSource(e) },
        { header: "what", cell: (e) => eventText(e) },
      ],
      rowTitle: (e) => e.shot || e.url || e.text || e.title,
      onRow: (e) => {
        activitySelected = e.id;
        renderActivityPanel();
      },
      onRowDblClick: (e) => {
        const data = eventText(e);
        if (data) pasteToActive(data + " ");
      },
    }),
  );
  renderActivityPreview();
}

// Preview pane: a screenshot thumbnail for os rows, the url/title for browser,
// the path for files. Guards a newer selection landing mid-load.
async function renderActivityPreview() {
  const pane = $("#activity-preview");
  const sel = store.get().activity.find((e) => e.id === activitySelected);
  if (!sel) {
    pane.innerHTML = `<div class="fs-preview-empty">select an event</div>`;
    return;
  }
  const head = `<div class="fs-preview-meta">${sel.kind} · ${eventSource(sel)}<br>
    <span>${fmtTime(sel.ts)}</span></div>`;
  if (sel.shot) {
    pane.innerHTML = head + `<div class="fs-preview-empty">loading…</div>`;
    try {
      const url = await invoke<string>("read_image", { path: sel.shot });
      if (activitySelected !== sel.id) return; // selection moved on
      pane.innerHTML = head + `<img class="fs-preview-img" src="${url}" alt="" />`;
    } catch (e) {
      pane.innerHTML = head + `<div class="fs-preview-empty">${e}</div>`;
    }
    return;
  }
  const body = sel.url
    ? `<div class="fs-preview-meta"><span>${sel.url}</span></div>`
    : "";
  const text = sel.text
    ? `<div class="fs-preview-meta">${sel.text}</div>`
    : "";
  pane.innerHTML = head + body + text || head + `<div class="fs-preview-empty">no preview</div>`;
}

// Load all sources once; the chip + search filter client-side (visibleActivity).
async function refreshActivity() {
  try {
    store.set({
      activity: await invoke<Event[]>("activity_events", {
        limit: ACTIVITY_CAP,
        source: null,
      }),
    });
  } catch (e) {
    console.error("activity_events:", e);
  }
}

// ---- config: observation filters (config.json), editable readout ----
async function refreshConfig() {
  try {
    store.set({ config: await invoke<ConfigView>("config_get") });
  } catch (e) {
    console.error("config_get:", e);
  }
}

// Persist a full set of rule lists and refresh the view from the backend.
async function applyConfig(sites: string[], files: string[], apps: string[]) {
  try {
    const view = await invoke<ConfigView>("config_set", {
      excludeSites: sites,
      excludeFiles: files,
      excludeApps: apps,
    });
    store.set({ config: view });
  } catch (e) {
    console.error("config_set:", e);
  }
}

// One editable rule group: removable chips + an add input. onChange gets the
// full next list for this group.
function cfgGroup(
  title: string,
  hint: string,
  items: string[],
  onChange: (next: string[]) => void,
): HTMLElement {
  const sec = document.createElement("div");
  sec.className = "cfg-group";
  const h = document.createElement("div");
  h.className = "cfg-group-head";
  h.innerHTML = `<b>${title}</b> <span class="muted">${hint}</span>`;
  sec.appendChild(h);

  const list = document.createElement("div");
  list.className = "cfg-chips";
  items.forEach((pat, i) => {
    const chip = document.createElement("span");
    chip.className = "cfg-chip";
    chip.textContent = pat;
    const x = document.createElement("span");
    x.className = "cfg-x";
    x.textContent = "×";
    x.onclick = () => onChange(items.filter((_, j) => j !== i));
    chip.appendChild(x);
    list.appendChild(chip);
  });
  sec.appendChild(list);

  const form = document.createElement("form");
  form.className = "cfg-add";
  const input = document.createElement("input");
  input.placeholder = "add pattern…";
  input.autocomplete = "off";
  const add = document.createElement("button");
  add.type = "submit";
  add.textContent = "+";
  form.appendChild(input);
  form.appendChild(add);
  form.onsubmit = (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (v && !items.includes(v)) onChange([...items, v]);
    input.value = "";
  };
  sec.appendChild(form);
  return sec;
}

function renderConfigPanel() {
  const cfg = store.get().config;
  const meta = $("#config-meta") as HTMLElement;
  const body = $("#config-body");
  if (!cfg) {
    meta.textContent = "";
    body.innerHTML = `<div class="empty-help">loading…</div>`;
    return;
  }
  meta.textContent =
    `${cfg.source}` + (cfg.excluded_count ? ` · ${cfg.excluded_count} blocked` : "");
  body.innerHTML = "";

  const head = document.createElement("div");
  head.className = "cfg-status";
  const errLine = cfg.error
    ? `<div class="cfg-err">⚠ ${cfg.error} — using defaults</div>`
    : "";
  head.innerHTML = `
    <div>loaded from <b>${cfg.source}</b></div>
    <code>${cfg.path}</code>
    ${errLine}
    <div class="muted">${cfg.excluded_count} events blocked since launch ·
      patterns are case-insensitive; <code>*</code> is a wildcard</div>`;
  body.appendChild(head);

  body.appendChild(
    cfgGroup(
      "Sites",
      "browser URLs to ignore (e.g. mail.google.com, *.bank.com)",
      cfg.exclude_sites,
      (next) => applyConfig(next, cfg.exclude_files, cfg.exclude_apps),
    ),
  );
  body.appendChild(
    cfgGroup(
      "Files",
      "file paths to ignore (e.g. /secret/, *.env)",
      cfg.exclude_files,
      (next) => applyConfig(cfg.exclude_sites, next, cfg.exclude_apps),
    ),
  );
  body.appendChild(
    cfgGroup(
      "Apps",
      "never screenshot while these apps are frontmost (e.g. 1Password)",
      cfg.exclude_apps,
      (next) => applyConfig(cfg.exclude_sites, cfg.exclude_files, next),
    ),
  );
}

// ---- files: a Windows-Explorer-style filesystem browser + media preview ----
const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif",
]);

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}
function fmtDate(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fileGlyph(e: FsEntry): string {
  if (e.is_dir) return "📁";
  if (IMAGE_EXTS.has(e.ext)) return "🖼";
  return "📄";
}
function typeLabel(e: FsEntry): string {
  if (e.is_dir) return "Folder";
  return e.ext ? `${e.ext.toUpperCase()} file` : "File";
}

// Record a file reference in the unified activity store (source='files').
function logFileOpen(e: FsEntry) {
  invoke("activity_log", {
    source: "files",
    kind: "open",
    title: e.name,
    text: e.path,
  }).catch(console.error);
}

async function browseTo(path: string) {
  try {
    const listing = await invoke<DirListing>("list_dir", { path });
    store.set({ files: listing, fsCwd: listing.path, fsSelected: null });
  } catch (e) {
    console.error("list_dir:", e);
    ($("#fs-list") as HTMLElement).innerHTML =
      `<div class="empty-help">Can't open<br><code>${path}</code><br>${e}</div>`;
  }
}

// Render the image (or a placeholder) for the selected entry into the preview
// pane. Guards against a newer selection landing while read_image is in flight.
async function renderPreview(sel: string | null, files: DirListing) {
  const pane = $("#fs-preview");
  const entry = sel ? files.entries.find((e) => e.path === sel) : null;
  if (!entry) {
    pane.innerHTML = `<div class="fs-preview-empty">select a file</div>`;
    return;
  }
  const meta = `<div class="fs-preview-meta">${entry.name}<br><span>${typeLabel(entry)} · ${fmtSize(entry.size)}</span></div>`;
  if (!IMAGE_EXTS.has(entry.ext)) {
    pane.innerHTML = meta + `<div class="fs-preview-empty">no preview</div>`;
    return;
  }
  pane.innerHTML = meta + `<div class="fs-preview-empty">loading…</div>`;
  try {
    const url = await invoke<string>("read_image", { path: entry.path });
    if (store.get().fsSelected !== entry.path) return; // selection moved on
    pane.innerHTML = meta + `<img class="fs-preview-img" src="${url}" alt="" />`;
  } catch (e) {
    pane.innerHTML = meta + `<div class="fs-preview-empty">${e}</div>`;
  }
}

function renderFilesPanel() {
  const { files, fsSelected } = store.get();
  ($("#fs-path") as HTMLInputElement).value = files?.path ?? store.get().fsCwd;
  const host = $("#fs-list");
  if (!files) {
    host.innerHTML = "";
    return;
  }
  const scroll = host.scrollTop; // selection re-renders the table; keep the view
  host.innerHTML = "";
  host.appendChild(
    renderTable<FsEntry>({
      rows: files.entries,
      rowClass: (e) => (e.path === fsSelected ? "fs-selected" : undefined),
      columns: [
        { header: "Name", cell: (e) => `${fileGlyph(e)}  ${e.name}` },
        { header: "Date modified", cell: (e) => fmtDate(e.modified) },
        { header: "Type", cell: (e) => typeLabel(e) },
        {
          header: "Size",
          cell: (e) => (e.is_dir ? "" : fmtSize(e.size)),
          cellClass: () => "fs-size",
        },
      ],
      rowTitle: (e) => e.path,
      // Folders open on a single click; files select (preview) then paste-on-open.
      onRow: (e) => (e.is_dir ? browseTo(e.path) : store.set({ fsSelected: e.path })),
      onRowDblClick: (e) => {
        if (e.is_dir) return;
        pasteToActive(pathArg(e.path) + " ");
        logFileOpen(e); // joins the unified activity history
      },
    }),
  );
  host.scrollTop = scroll;
  renderPreview(fsSelected, files);
}

// Lazy first load when a panel becomes the active tab in its zone. Idempotent:
// each loader guards on its own already-loaded state. Wired into dock via
// setDockHooks so it fires wherever the panel is docked.
function onPanelShown(id: PanelId) {
  if (id === "worktrees" && store.get().worktrees.length === 0) scanWorktrees();
  else if (id === "activity" && store.get().activity.length === 0) refreshActivity();
  else if (id === "files" && !store.get().files) browseTo(store.get().fsCwd);
  else if (id === "config" && !store.get().config) refreshConfig();
}

// Reflect which panels are docked on the activity-rail buttons.
function syncToggles() {
  const m: [string, PanelId][] = [
    ["#sessions-toggle", "sessions"],
    ["#wt-toggle", "worktrees"],
    ["#activity-toggle", "activity"],
    ["#files-toggle", "files"],
    ["#config-toggle", "config"],
  ];
  for (const [sel, id] of m)
    ($(sel) as HTMLButtonElement).classList.toggle("active", isOpen(id));
}

// Refit the active terminal — dockview calls this via onTerminalLayout whenever
// the terminal group is resized or re-laid-out.
function fitActiveTerm() {
  const t = activeId() ? tabs.get(activeId()!) : undefined;
  if (!t) return;
  requestAnimationFrame(() => {
    t.fit.fit();
    invoke("resize_pty", { id: t.id, cols: t.term.cols, rows: t.term.rows }).catch(() => {});
  });
}

// Activity rail compact (icons) vs big (icons + labels).
function syncSidebar(s: AppState) {
  $("#actbar").dataset.mode = s.sidebar;
}

// ---- store-driven view sync: skin and mode push to the DOM + controls ----
function syncSkin(s: AppState) {
  document.body.dataset.skin = s.skin;
  // Button shows the skin it switches TO.
  ($("#skin-toggle") as HTMLButtonElement).textContent = nextSkin(s.skin).toUpperCase();
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
function syncRecord(s: AppState) {
  const b = $("#activity-record") as HTMLButtonElement;
  b.classList.toggle("recording", s.captureEnabled);
  b.textContent = s.captureEnabled ? "● Recording" : "○ Record";
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

// Drag the divider to resize the sidebar; width persists in the store.
// Window edge/corner grips. decorations:false means macOS gives no native
// resize handles, so each grip hands the drag to Tauri's startResizeDragging.
// The data-dir strings match Tauri's ResizeDirection enum values exactly.
function wireWindowResize() {
  const win = getCurrentWindow();
  document.querySelectorAll<HTMLElement>(".rz").forEach((grip) => {
    grip.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      // ResizeDirection is an internal union; dataset.dir already holds a valid
      // member ('North' | 'SouthEast' | …) so cast through the param type.
      win.startResizeDragging(grip.dataset.dir as never).catch(console.error);
    });
  });
}

// Contextual right-click items, keyed off what the click landed on. Row data is
// recovered from the row's title attr (file rows carry the path, activity rows
// the shot/url/text), so no per-row wiring is needed.
function ctxItemsFor(target: HTMLElement): CtxItem[] {
  const copy = (s: string) => navigator.clipboard.writeText(s).catch(() => {});

  // A file row in the Files explorer.
  const fsRow = target.closest("#fs-list tr.dtable-row") as HTMLElement | null;
  if (fsRow?.title) {
    const path = fsRow.title;
    return [
      { label: "Open (paste path)", action: () => pasteToActive(pathArg(path) + " ") },
      { label: "Copy path", action: () => copy(path) },
      { sep: true },
      { label: "Up one folder", action: () => $("#fs-up").click() },
    ];
  }

  // An activity-timeline row.
  const actRow = target.closest("#activity-table tr.dtable-row") as HTMLElement | null;
  if (actRow?.title) {
    const data = actRow.title;
    return [
      { label: "Paste", action: () => pasteToActive(data + " ") },
      { label: "Copy", action: () => copy(data) },
    ];
  }

  // Inside a terminal.
  if (target.closest(".term-host")) {
    return [
      {
        label: "Paste",
        action: async () => {
          try {
            pasteToActive(await navigator.clipboard.readText());
          } catch {
            /* clipboard blocked */
          }
        },
      },
      {
        label: "Clear",
        action: () => {
          const id = activeId();
          if (id) tabs.get(id)?.term.clear();
        },
      },
      { sep: true },
      { label: "Screenshot region", action: captureToPrompt },
    ];
  }

  // Default: window-level actions.
  return [
    {
      label: "New session",
      action: () => ($("#new-name") as HTMLInputElement).focus(),
    },
    { sep: true },
    { label: "Cycle skin", action: () => store.set({ skin: nextSkin(store.get().skin) }) },
    {
      label: store.get().mode === "dark" ? "Light mode" : "Dark mode",
      action: () =>
        store.set({ mode: store.get().mode === "dark" ? "light" : "dark" }),
    },
  ];
}

function wireChrome() {
  $("#skin-toggle").onclick = () =>
    store.set({ skin: nextSkin(store.get().skin) });

  $("#mode-toggle").onclick = () =>
    store.set({ mode: store.get().mode === "dark" ? "light" : "dark" });

  $("#shot-btn").onclick = captureToPrompt;

  $("#sessions-toggle").onclick = () => togglePanel("sessions");
  $("#actbar-toggle").onclick = () =>
    store.set({ sidebar: store.get().sidebar === "big" ? "compact" : "big" });

  $("#wt-toggle").onclick = () => togglePanel("worktrees");
  $("#wt-scan").addEventListener("submit", (e) => {
    e.preventDefault();
    scanWorktrees();
  });
  $("#wt-view").onclick = () =>
    store.set({ wtView: store.get().wtView === "tree" ? "table" : "tree" });

  $("#activity-toggle").onclick = () => togglePanel("activity");
  $("#activity-clear").onclick = () =>
    invoke("activity_clear")
      .then(() => {
        activitySelected = null;
        store.set({ activity: [] });
      })
      .catch(console.error);

  // Recording toggle mirrors backend CaptureEnabled (flag persisted on front).
  $("#activity-record").onclick = () => {
    const on = !store.get().captureEnabled;
    store.set({ captureEnabled: on });
    invoke("capture_set_enabled", { on }).catch(console.error);
  };

  // fzf search box filters live (runtime-only state).
  $("#activity-search").addEventListener("input", (e) => {
    store.set({ activityQuery: (e.target as HTMLInputElement).value });
  });

  // Source + type filter chips.
  document.querySelectorAll<HTMLButtonElement>(".act-chip[data-src]").forEach((b) => {
    b.onclick = () =>
      store.set({ activitySource: b.dataset.src as ActivitySource });
  });
  document.querySelectorAll<HTMLButtonElement>(".act-chip[data-type]").forEach((b) => {
    b.onclick = () => store.set({ activityType: b.dataset.type as ActivityType });
  });

  $("#config-toggle").onclick = () => togglePanel("config");
  $("#config-reload").onclick = () =>
    invoke<ConfigView>("config_reload")
      .then((view) => store.set({ config: view }))
      .catch(console.error);
  $("#config-open").onclick = () => invoke("config_open").catch(console.error);

  $("#files-toggle").onclick = () => togglePanel("files");
  $("#fs-up").onclick = () => {
    const f = store.get().files;
    if (f?.parent) browseTo(f.parent);
  };
  const goPath = () => browseTo(($("#fs-path") as HTMLInputElement).value);
  $("#fs-go").onclick = goPath;
  $("#fs-path").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") goPath();
  });

  $("#min-btn").onclick = () => getCurrentWindow().minimize();
  $("#max-btn").onclick = () => getCurrentWindow().toggleMaximize();
  $("#hide-btn").onclick = () => getCurrentWindow().hide();

  // Quick-launch an agent session (creates the tmux session running the agent).
  $("#ql-claude").onclick = () => {
    openTab("claude", { command: "claude" });
    refreshSessions();
  };
  $("#ql-opencode").onclick = () => {
    openTab("opencode", { command: "opencode" });
    refreshSessions();
  };

  $("#new-session").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#new-name") as HTMLInputElement;
    const name = input.value.trim();
    if (!name) return;
    input.value = "";
    openTab(name); // plain shell (no agent command)
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
  store.subscribe(syncSidebar, ["sidebar"]);
  // dockview owns the layout; we only react: lazy-load a panel when it's first
  // shown, and refit the active terminal whenever dockview re-lays-out a group.
  setDockHooks({ onShow: onPanelShown, onTerminalLayout: fitActiveTerm });
  store.subscribe((s) => renderWorkspaces(s.workspaces), ["workspaces"]);
  store.subscribe(renderWorktreesPanel, ["worktrees", "wtView", "wtExpanded"]);
  store.subscribe(renderActivityPanel, [
    "activity",
    "activitySource",
    "activityType",
    "activityQuery",
  ]);
  store.subscribe(syncRecord, ["captureEnabled"]);
  store.subscribe(renderConfigPanel, ["config"]);
  store.subscribe(renderFilesPanel, ["files", "fsSelected"]);
  syncSkin(store.get());
  syncMode(store.get());
  syncSidebar(store.get());
  renderWorktreesPanel();
  renderActivityPanel();
  renderFilesPanel();
  syncRecord(store.get());
  // Re-apply the persisted recording flag to the backend (default off there).
  invoke("capture_set_enabled", { on: store.get().captureEnabled }).catch(
    console.error,
  );

  ($("#wt-root") as HTMLInputElement).value = store.get().scanRoot;
  wireChrome();
  // A dock failure must not abort the rest of boot (sessions, pty listeners).
  try {
    onDockChange(syncToggles); // keep rail highlights in sync as panels open/close
    mountReactDock($("#dock")); // dockview-react renders + adopts the pooled panels
    syncToggles();
  } catch (e) {
    showError("wireDock", e);
  }
  wireWindowResize();
  wireDragDrop();
  wireContextMenu(ctxItemsFor);
  await refreshSessions();
  await refreshWorkspaces();

  await listen<{ id: string; chunk: string }>("pty-data", (e) => {
    tabs.get(e.payload.id)?.term.write(e.payload.chunk);
  });

  // Reattach tabs that were open before the reload. The tmux sessions (and the
  // agents inside) are still alive in the Rust backend; `tmux new-session -A`
  // reattaches. Capture the wanted active id first — openTab() flips active as
  // it replays — then restore it once all tabs exist.
  const wantActive = store.get().active;
  replaying = true; // don't log restored tabs as fresh visits
  for (const t of store.get().openTabs) {
    openTab(t.name, { command: t.command, cwd: t.cwd });
  }
  replaying = false;
  if (wantActive && tabs.has(wantActive)) activate(wantActive);

  // Backend pushes the registry whenever a Space is created/removed.
  await listen<Workspace[]>("workspaces-changed", (e) => {
    store.set({ workspaces: e.payload });
  });

  // Each new activity row (browser ingest, os capture, file open) arrives here;
  // prepend, newest-first, capped.
  await listen<Event>("activity-added", (e) => {
    store.set({
      activity: [e.payload, ...store.get().activity].slice(0, ACTIVITY_CAP),
    });
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

  // Reflow xterm AND push the new grid to the pty, else tmux keeps its old size
  // and strands a stale status line mid-screen after a window resize.
  new ResizeObserver(() => {
    const id = activeId();
    const t = id ? tabs.get(id) : undefined;
    if (!t) return;
    t.fit.fit();
    invoke("resize_pty", { id, cols: t.term.cols, rows: t.term.rows }).catch(
      () => {},
    );
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

// Surface any boot/runtime error as a visible banner — the webview console
// isn't reachable from the terminal, so this is how errors get seen.
function showError(label: string, err: unknown) {
  const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  let el = document.getElementById("boot-error");
  if (!el) {
    el = document.createElement("pre");
    el.id = "boot-error";
    el.style.cssText =
      "position:fixed;left:8px;right:8px;bottom:8px;z-index:99999;max-height:40%;overflow:auto;margin:0;padding:8px;background:#a00;color:#fff;font:11px/1.4 Menlo,monospace;white-space:pre-wrap;border:2px solid #fff;";
    document.body.appendChild(el);
  }
  el.textContent = `[${label}] ${msg}`;
  console.error(label, err);
}
window.addEventListener("error", (e) => showError("error", e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => showError("promise", e.reason));

main().catch((e) => showError("main", e));
