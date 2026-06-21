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
  type DirListing,
  type FsEntry,
  type Skin,
  type SpyEvent,
  type Workspace,
  type WorktreeRow,
} from "./state";
import { renderTable } from "./table";

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
  openTab(tmuxName(`${baseName(clone)}-${branch}`), { cwd: wtPath });
  store.set({ panel: "terminal" });
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

// ---- spy: browser events captured by the extension (localhost ingest) ----
const SPY_CAP = 500;
const prettyUrl = (u: string) =>
  u.replace(/^https?:\/\//, "").replace(/^www\./, "");
function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Drop text into the active terminal (a spy row's text/url paste target).
function pasteToActive(data: string) {
  const id = activeId();
  if (!id || !data) return;
  invoke("write_pty", { id, data }).catch(console.error);
  tabs.get(id)?.term.focus();
}

// Shown in the Spy panel before any event arrives: how to wire the extension
// to the localhost ingest server (which is already running while the app is up).
function spySetupCard(): HTMLElement {
  const el = document.createElement("div");
  el.className = "empty-help";
  el.innerHTML = `
    <h3>browser spy — setup</h3>
    <p>The ingest server is <b>already running</b> at <code>127.0.0.1:8787</code>
       while instant is open. Install the extension to start capturing:</p>
    <ol>
      <li>Open <code>chrome://extensions</code></li>
      <li>Enable <b>Developer mode</b> (top-right)</li>
      <li><b>Load unpacked</b> → pick the <code>extension/</code> folder in the instant repo</li>
    </ol>
    <p>Page loads, text selections, and copies then stream into this table.
       Click any row to paste its text/url into the active terminal.</p>
    <p class="muted">Test it without the browser:</p>
    <pre>curl -XPOST 127.0.0.1:8787/ingest \\
  -H 'content-type: application/json' \\
  -d '{"kind":"nav","url":"https://example.com","title":"Example"}'</pre>`;
  return el;
}

function renderSpyPanel() {
  const { spy } = store.get();
  ($("#spy-count") as HTMLElement).textContent = spy.length
    ? `${spy.length} events`
    : "";
  const host = $("#spy-table");
  host.innerHTML = "";
  if (spy.length === 0) {
    host.appendChild(spySetupCard());
    return;
  }
  host.appendChild(
    renderTable<SpyEvent>({
      rows: spy,
      columns: [
        { header: "time", cell: (e) => fmtTime(e.ts) },
        { header: "kind", cell: (e) => e.kind },
        { header: "source", cell: (e) => e.title || prettyUrl(e.url) },
        { header: "text", cell: (e) => e.text },
      ],
      rowTitle: (e) => e.url || e.text,
      onRow: (e) => pasteToActive((e.text || e.url) + " "),
    }),
  );
}

async function refreshSpy() {
  try {
    store.set({ spy: await invoke<SpyEvent[]>("spy_events", { limit: SPY_CAP }) });
  } catch (e) {
    console.error("spy_events:", e);
  }
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
        if (!e.is_dir) pasteToActive(pathArg(e.path) + " ");
      },
    }),
  );
  host.scrollTop = scroll;
  renderPreview(fsSelected, files);
}

function syncPanel(s: AppState) {
  document.body.dataset.panel = s.panel;
  ($("#wt-toggle") as HTMLButtonElement).classList.toggle(
    "active",
    s.panel === "worktrees",
  );
  ($("#spy-toggle") as HTMLButtonElement).classList.toggle("active", s.panel === "spy");
  ($("#files-toggle") as HTMLButtonElement).classList.toggle(
    "active",
    s.panel === "files",
  );
  // Lazy first load when a panel is opened empty.
  if (s.panel === "worktrees" && store.get().worktrees.length === 0) scanWorktrees();
  if (s.panel === "spy" && store.get().spy.length === 0) refreshSpy();
  if (s.panel === "files" && !store.get().files) browseTo(store.get().fsCwd);
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
function wireResizer() {
  const resizer = $("#sidebar-resizer");
  const sidebar = $(".sidebar") as HTMLElement;
  sidebar.style.width = `${store.get().sidebarWidth}px`;

  let dragging = false;
  resizer.addEventListener("pointerdown", (e) => {
    dragging = true;
    resizer.setPointerCapture(e.pointerId);
    resizer.classList.add("dragging");
    document.body.style.cursor = "col-resize";
  });
  resizer.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const left = sidebar.getBoundingClientRect().left;
    const w = Math.min(420, Math.max(110, e.clientX - left));
    sidebar.style.width = `${w}px`;
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove("dragging");
    document.body.style.cursor = "";
    store.set({ sidebarWidth: Math.round(sidebar.getBoundingClientRect().width) });
  };
  resizer.addEventListener("pointerup", end);
  resizer.addEventListener("pointercancel", end);
}

function wireChrome() {
  $("#skin-toggle").onclick = () =>
    store.set({ skin: nextSkin(store.get().skin) });

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
  $("#wt-view").onclick = () =>
    store.set({ wtView: store.get().wtView === "tree" ? "table" : "tree" });

  $("#spy-toggle").onclick = () =>
    store.set({ panel: store.get().panel === "spy" ? "terminal" : "spy" });
  $("#spy-clear").onclick = () =>
    invoke("spy_clear")
      .then(() => store.set({ spy: [] }))
      .catch(console.error);

  $("#files-toggle").onclick = () =>
    store.set({ panel: store.get().panel === "files" ? "terminal" : "files" });
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
  store.subscribe(renderWorktreesPanel, ["worktrees", "wtView", "wtExpanded"]);
  store.subscribe(renderSpyPanel, ["spy"]);
  store.subscribe(renderFilesPanel, ["files", "fsSelected"]);
  syncSkin(store.get());
  syncMode(store.get());
  syncPanel(store.get());
  renderWorktreesPanel();
  renderSpyPanel();
  renderFilesPanel();

  ($("#wt-root") as HTMLInputElement).value = store.get().scanRoot;
  wireChrome();
  wireResizer();
  wireDragDrop();
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
  for (const t of store.get().openTabs) {
    openTab(t.name, { command: t.command, cwd: t.cwd });
  }
  if (wantActive && tabs.has(wantActive)) activate(wantActive);

  // Backend pushes the registry whenever a Space is created/removed.
  await listen<Workspace[]>("workspaces-changed", (e) => {
    store.set({ workspaces: e.payload });
  });

  // Each captured browser event arrives here; prepend, newest-first, capped.
  await listen<SpyEvent>("spy-ingested", (e) => {
    store.set({ spy: [e.payload, ...store.get().spy].slice(0, SPY_CAP) });
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
