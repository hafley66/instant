// Sprefa plugin: a schema explorer + scratch datalog runner over the sprefa
// daemon socket, plus the "scope tray" (a selection of file/repo/rev entities
// that gets prepended to scratch queries as sel_* facts).
import { invoke } from "@tauri-apps/api/core";
import { store, type SprefaScopeItem, type SprefaScopeKind } from "./state";
import { registerPlugin, type RailChild } from "./plugin";
import { openPreviewPanel } from "./preview";
import { showContextMenu } from "./ctxmenu";
import { baseName, getHomeDir } from "./core";
import { SprefaPanelV2 } from "./sprefaPanel";

type SprefaCol = { name: string; ty: string };
type SprefaRel = { name: string; columns: SprefaCol[]; builtin?: boolean };

const SPREFA_ROOT_KEY = "sprefa.root";
let sprefaRoot = localStorage.getItem(SPREFA_ROOT_KEY) ?? "~/projects/sprefa/v5";

// The one relation pinned under the sprefa rail button (right-click a rel row
// in the schema tree to pin/unpin). Raw localStorage like root/scratch above.
const SPREFA_RAIL_REL_KEY = "sprefa.railRel";

function node(cls: string, ...kids: HTMLElement[]): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  for (const k of kids) d.appendChild(k);
  return d;
}
function span(cls: string, text: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
}

type SprefaSite = { file: string; line: number; text: string; kind: string };

// Open a .dl/.rs file in a preview tab. `line` (>0) marks + scrolls to that row
// in the line-numbered source view; 0 opens the rendered (syntax-highlighted)
// view. Routes through the per-path tab machinery like every other preview.
function openSprefaSource(file: string, line: number) {
  openPreviewPanel(file, line > 0 ? line : undefined);
}

async function loadSprefaSites(rel: string, host: HTMLElement) {
  host.replaceChildren(node("sprefa-src-empty", span("wt-meta", "finding source…")));
  let sites: SprefaSite[] = [];
  try {
    sites = await invoke<SprefaSite[]>("sprefa_rel_source", { root: sprefaRoot, rel });
  } catch (e) {
    host.replaceChildren(node("sprefa-src-empty", span("wt-meta", String(e))));
    return;
  }
  if (sites.length === 0) {
    host.replaceChildren(
      node("sprefa-src-empty", span("wt-meta", "builtin · emitted by the engine (no .dl rule)")),
    );
    return;
  }
  host.replaceChildren();
  for (const s of sites) {
    const rel = s.file.split("/").slice(-2).join("/");
    const row = node(
      "wt-node sprefa-site",
      span("sprefa-kind sprefa-kind-" + s.kind, s.kind),
      span("wt-label", `${rel}:${s.line}`),
    );
    row.title = s.text;
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      openSprefaSource(s.file, s.line);
    });
    host.appendChild(row);
  }
}

function renderSprefaSchema(rels: SprefaRel[]) {
  const tree = document.querySelector<HTMLElement>("#sprefa-schema");
  if (!tree) return;
  tree.replaceChildren();
  // Declared relations first, built-ins (source/meta tables) after; each block
  // sorted by name.
  const sorted = [...rels].sort(
    (a, b) => Number(!!a.builtin) - Number(!!b.builtin) || a.name.localeCompare(b.name),
  );
  for (const r of sorted) {
    const glyph = span("wt-glyph", "▸");
    const row = node(
      "wt-node sprefa-rel" + (r.builtin ? " sprefa-builtin" : ""),
      glyph,
      span("wt-label", r.name),
      span("wt-meta", String(r.columns.length)),
    );
    const detail = node("sprefa-detail");
    detail.hidden = true;
    const cols = node("sprefa-cols");
    for (const c of r.columns) {
      cols.appendChild(
        node("wt-node sprefa-col", span("wt-glyph", ""), span("wt-label", c.name), span("wt-meta", c.ty)),
      );
    }
    const src = node("sprefa-src");
    detail.appendChild(span("sprefa-head", "columns"));
    detail.appendChild(cols);
    detail.appendChild(span("sprefa-head", "defined in"));
    detail.appendChild(src);
    let sourced = false;
    row.addEventListener("click", () => {
      detail.hidden = !detail.hidden;
      glyph.textContent = detail.hidden ? "▸" : "▾";
      if (!detail.hidden && !sourced) {
        sourced = true;
        loadSprefaSites(r.name, src);
      }
    });
    // Right-click pins/unpins this relation under the sprefa rail button (see
    // sprefaRailChildren). stopPropagation keeps main.ts's global
    // wireContextMenu dispatcher from also firing, like rail.ts's menu.
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const pinned = localStorage.getItem(SPREFA_RAIL_REL_KEY) === r.name;
      showContextMenu(e.clientX, e.clientY, [
        {
          label: pinned ? "unpin from rail" : "pin to rail",
          action: () => {
            if (pinned) localStorage.removeItem(SPREFA_RAIL_REL_KEY);
            else localStorage.setItem(SPREFA_RAIL_REL_KEY, r.name);
          },
        },
      ]);
    });
    tree.appendChild(row);
    tree.appendChild(detail);
  }
}

export async function loadSprefaSchema() {
  const status = document.querySelector<HTMLElement>("#sprefa-status");
  const tree = document.querySelector<HTMLElement>("#sprefa-schema");
  if (!tree || !status) return;
  status.textContent = "loading…";
  try {
    const res = await invoke<{ relations: SprefaRel[] }>("sprefa_schema", { root: sprefaRoot });
    renderSprefaSchema(res.relations);
    const builtins = res.relations.filter((r) => r.builtin).length;
    const declared = res.relations.length - builtins;
    status.textContent = `${res.relations.length} relations (${declared} rules, ${builtins} builtin)`;
    // The loaded .dl program: ping reports the actual file set the daemon
    // parsed. Prepend it above the relation tree so it's clear which rules are
    // in effect (multiple files merge into one program).
    try {
      const ping = await invoke<{ program: string; program_files?: string[] }>("sprefa_ping", {
        root: sprefaRoot,
      });
      const files = ping.program_files?.length ? ping.program_files : [ping.program].filter(Boolean);
      const info = node("sprefa-program");
      info.append(span("sprefa-head", `loaded program${files.length === 1 ? "" : `s (${files.length})`}`));
      if (files.length === 0) info.append(span("wt-label", "(none)"));
      for (const f of files) {
        const row = span("wt-label sprefa-program-file", f.split("/").pop() ?? f);
        row.title = f;
        // Click opens the file in the Preview pane; also a draggable file entity
        // (scope tray + right-click), like result cells and fs rows.
        row.dataset.entityKind = "file";
        row.dataset.entityValue = f;
        row.draggable = true;
        row.addEventListener("click", () => openSprefaSource(f, 0));
        info.append(row);
      }
      tree.prepend(info);
    } catch {
      /* ping optional; schema already rendered */
    }
  } catch (e) {
    tree.replaceChildren();
    status.textContent = String(e);
  }
}

type SprefaQueryResult = { rel: string; columns: string[]; rows: unknown[][] };
type SprefaDiag = { severity: string; code?: string; message: string };
type SprefaEval = { ok: boolean; results: SprefaQueryResult[]; diagnostics: SprefaDiag[] };

const SPREFA_SCRATCH_KEY = "sprefa.scratch";

function showSprefaView(view: "schema" | "scratch") {
  const schema = document.querySelector<HTMLElement>("#sprefa-schema");
  const scratch = document.querySelector<HTMLElement>("#sprefa-scratch");
  if (schema) schema.hidden = view !== "schema";
  if (scratch) scratch.hidden = view !== "scratch";
  document
    .querySelector("#sprefa-tab-schema")
    ?.classList.toggle("on", view === "schema");
  document
    .querySelector("#sprefa-tab-scratch")
    ?.classList.toggle("on", view === "scratch");
  if (view === "scratch") document.querySelector<HTMLTextAreaElement>("#sprefa-scratch-src")?.focus();
}

// Classify a result column as a common entity by its header name, falling back
// to the value shape. Returns null for plain values (names, counts, lines).
function entityKind(col: string, value: string): SprefaScopeKind | null {
  if (/^repo$/i.test(col)) return "repo";
  if (/rev/i.test(col)) return "rev";
  if (/(^|_)(path|file)$/i.test(col)) return "file";
  if (!value) return null;
  if (value === "WORK" || /^[0-9a-f]{7,40}$/i.test(value)) return "rev";
  if (value.includes("/") && /\.[a-z0-9]{1,8}$/i.test(value)) return "file";
  return null;
}

// A result/header cell. When `kind` is set the cell becomes a draggable entity
// (data-entity-* attrs shared with fs rows) and gets click-to-toggle wiring via
// the global handlers. `entity-on` marks values already in the scope tray.
function cell(text: string, tag: "td" | "th" = "td", kind: SprefaScopeKind | null = null): HTMLElement {
  const el = document.createElement(tag);
  el.textContent = text;
  if (kind && tag === "td") {
    el.dataset.entityKind = kind;
    el.dataset.entityValue = text;
    el.draggable = true;
    el.className = "entity";
    if (inScope(kind, text)) el.classList.add("entity-on");
  }
  return el;
}

// ---- sprefa scope tray --------------------------------------------------

export function inScope(kind: SprefaScopeKind, value: string): boolean {
  return store.get().sprefaScope.some((s) => s.kind === kind && s.value === value);
}

export function addScope(item: SprefaScopeItem) {
  if (inScope(item.kind, item.value)) return;
  store.set({ sprefaScope: [...store.get().sprefaScope, item] });
}

function removeScope(kind: SprefaScopeKind, value: string) {
  store.set({
    sprefaScope: store.get().sprefaScope.filter((s) => !(s.kind === kind && s.value === value)),
  });
}

export function toggleScope(kind: SprefaScopeKind, value: string) {
  if (inScope(kind, value)) removeScope(kind, value);
  else addScope({ kind, value });
}

// Datalog facts for the active selection, prepended to a scratch query so it can
// join: e.g. `scan(R, "WORK", g, _), sel_repo(R)`. Empty when scope is off/empty.
function scopePrelude(): string {
  const { sprefaScope, sprefaScopeActive } = store.get();
  if (!sprefaScopeActive || sprefaScope.length === 0) return "";
  const rels: Record<SprefaScopeKind, { rel: string; col: string }> = {
    repo: { rel: "sel_repo", col: "repo" },
    file: { rel: "sel_file", col: "path" },
    rev: { rel: "sel_rev", col: "rev" },
  };
  const lines: string[] = [];
  for (const kind of ["repo", "file", "rev"] as SprefaScopeKind[]) {
    const vals = sprefaScope.filter((s) => s.kind === kind).map((s) => s.value);
    if (!vals.length) continue;
    const { rel, col } = rels[kind];
    lines.push(`rel ${rel}(${col}: text).`);
    for (const v of vals) lines.push(`${rel}(${JSON.stringify(v)}).`);
  }
  return lines.length ? lines.join("\n") + "\n\n" : "";
}

function renderSprefaScope() {
  const host = document.querySelector<HTMLElement>("#sprefa-scope");
  if (!host) return;
  const { sprefaScope, sprefaScopeActive } = store.get();
  host.replaceChildren();
  host.classList.toggle("active", sprefaScopeActive);

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "sprefa-scope-toggle" + (sprefaScopeActive ? " on" : "");
  toggle.title = sprefaScopeActive
    ? "scope ON — sel_repo/sel_file/sel_rev facts prepended to queries"
    : "scope OFF — selection is a collection only";
  toggle.textContent = sprefaScopeActive ? "scope ●" : "scope ○";
  toggle.onclick = () => store.set({ sprefaScopeActive: !store.get().sprefaScopeActive });
  host.appendChild(toggle);

  if (sprefaScope.length === 0) {
    host.appendChild(span("wt-meta", "drag or click files/repos/revs here"));
    return;
  }
  for (const it of sprefaScope) {
    const chip = node(`sprefa-chip kind-${it.kind}`);
    chip.append(span("sprefa-chip-kind", it.kind), span("sprefa-chip-val", it.value));
    const x = document.createElement("button");
    x.type = "button";
    x.className = "sprefa-chip-x";
    x.textContent = "×";
    x.onclick = () => removeScope(it.kind, it.value);
    chip.appendChild(x);
    host.appendChild(chip);
  }
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "sprefa-scope-clear";
  clear.textContent = "clear";
  clear.onclick = () => store.set({ sprefaScope: [] });
  host.appendChild(clear);
}

function renderSprefaEval(res: SprefaEval) {
  const out = document.querySelector<HTMLElement>("#sprefa-scratch-out");
  if (!out) return;
  out.replaceChildren();
  const errs = res.diagnostics.filter((d) => d.severity === "error");
  for (const d of errs) {
    const row = node("sprefa-diag err");
    row.textContent = `${d.code ? `[${d.code}] ` : ""}${d.message}`;
    out.appendChild(row);
  }
  if (!res.ok) return;
  if (res.results.length === 0) {
    out.appendChild(node("sprefa-src-empty", span("wt-meta", "no ? query — add e.g. ? hot(name, line).")));
    return;
  }
  for (const q of res.results) {
    const head = node("sprefa-qhead");
    head.append(span("wt-label", `? ${q.rel}`), span("wt-meta", `${q.rows.length} rows`));
    out.appendChild(head);
    const table = document.createElement("table");
    table.className = "dtable sprefa-qtable";
    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    for (const c of q.columns) htr.appendChild(cell(c, "th"));
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    // Classify columns once from the header + first non-empty value per column.
    const kinds = q.columns.map((c, i) => {
      const sample = q.rows.find((row) => row[i] != null);
      return entityKind(c, sample ? String(sample[i]) : "");
    });
    for (const r of q.rows.slice(0, 500)) {
      const tr = document.createElement("tr");
      r.forEach((v, i) => tr.appendChild(cell(v == null ? "" : String(v), "td", kinds[i])));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    out.appendChild(table);
    if (q.rows.length > 500) {
      out.appendChild(node("sprefa-src-empty", span("wt-meta", `… ${q.rows.length - 500} more rows`)));
    }
  }
}

async function runSprefaScratch() {
  const src = document.querySelector<HTMLTextAreaElement>("#sprefa-scratch-src");
  const status = document.querySelector<HTMLElement>("#sprefa-scratch-status");
  if (!src || !status) return;
  const text = src.value;
  localStorage.setItem(SPREFA_SCRATCH_KEY, text);
  status.textContent = "running…";
  try {
    const res = await invoke<SprefaEval>("sprefa_eval", {
      root: sprefaRoot,
      text: scopePrelude() + text,
    });
    renderSprefaEval(res);
    const n = res.results.reduce((a, q) => a + q.rows.length, 0);
    status.textContent = res.ok ? `${n} rows` : "errors";
  } catch (e) {
    const out = document.querySelector<HTMLElement>("#sprefa-scratch-out");
    if (out) {
      const row = node("sprefa-diag err");
      row.textContent = String(e);
      out.replaceChildren(row);
    }
    status.textContent = "failed";
  }
}

const SPREFA_DND_MIME = "application/x-sprefa-entity";

// Re-render the tray and re-mark already-rendered result cells when the scope
// changes. Cheap class toggle avoids re-running the query.
function refreshSprefaScopeUI() {
  renderSprefaScope();
  document
    .querySelectorAll<HTMLElement>("#sprefa-scratch-out [data-entity-kind]")
    .forEach((el) =>
      el.classList.toggle(
        "entity-on",
        inScope(el.dataset.entityKind as SprefaScopeKind, el.dataset.entityValue ?? ""),
      ),
    );
}

let sprefaWired = false;
export function wireSprefa() {
  const input = document.querySelector<HTMLInputElement>("#sprefa-root");
  if (input) input.value = sprefaRoot;
  const scratchSrc = document.querySelector<HTMLTextAreaElement>("#sprefa-scratch-src");
  if (scratchSrc && !scratchSrc.value) scratchSrc.value = localStorage.getItem(SPREFA_SCRATCH_KEY) ?? "";
  renderSprefaScope();
  if (sprefaWired) return;
  sprefaWired = true;

  // Drag any entity (result cell or fs row) -> carry its typed value.
  document.addEventListener("dragstart", (e) => {
    const el = (e.target as HTMLElement)?.closest?.("[data-entity-kind]") as HTMLElement | null;
    if (!el || !e.dataTransfer) return;
    const item = { kind: el.dataset.entityKind, value: el.dataset.entityValue ?? "" };
    e.dataTransfer.setData(SPREFA_DND_MIME, JSON.stringify(item));
    e.dataTransfer.setData("text/plain", item.value);
    e.dataTransfer.effectAllowed = "copy";
  });

  // The tray is a drop zone for in-app entity drags.
  const tray = document.querySelector<HTMLElement>("#sprefa-scope");
  tray?.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types.includes(SPREFA_DND_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    tray.classList.add("drop-hover");
  });
  tray?.addEventListener("dragleave", () => tray.classList.remove("drop-hover"));
  tray?.addEventListener("drop", (e) => {
    tray.classList.remove("drop-hover");
    const raw = e.dataTransfer?.getData(SPREFA_DND_MIME);
    if (!raw) return;
    e.preventDefault();
    try {
      const it = JSON.parse(raw) as SprefaScopeItem;
      if (it.kind && it.value) addScope(it);
    } catch {
      /* malformed payload */
    }
  });

  // Left-click an entity result cell toggles it into the selection.
  document.querySelector("#sprefa-scratch-out")?.addEventListener("click", (e) => {
    const el = (e.target as HTMLElement)?.closest?.("[data-entity-kind]") as HTMLElement | null;
    if (!el) return;
    toggleScope(el.dataset.entityKind as SprefaScopeKind, el.dataset.entityValue ?? "");
  });

  store.subscribe(() => refreshSprefaScopeUI(), ["sprefaScope", "sprefaScopeActive"]);
  const form = document.querySelector<HTMLFormElement>("#sprefa-bar");
  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    if (input) {
      sprefaRoot = input.value.trim();
      localStorage.setItem(SPREFA_ROOT_KEY, sprefaRoot);
    }
    loadSprefaSchema();
  });
  document.querySelector("#sprefa-tab-schema")?.addEventListener("click", () => showSprefaView("schema"));
  document.querySelector("#sprefa-tab-scratch")?.addEventListener("click", () => showSprefaView("scratch"));
  document.querySelector("#sprefa-run")?.addEventListener("click", runSprefaScratch);
  scratchSrc?.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      runSprefaScratch();
    }
  });
}

// ---- rail children (pinned relation) --------------------------------------

// Schema memo for the rail provider, keyed by root: rail rebuilds happen far
// more often than the schema changes, so one invoke per root is plenty.
let railSchemaMemo: { root: string; schema: Promise<{ relations: SprefaRel[] }> } | null = null;
function railSchema(root: string): Promise<{ relations: SprefaRel[] }> {
  if (!railSchemaMemo || railSchemaMemo.root !== root) {
    railSchemaMemo = { root, schema: invoke<{ relations: SprefaRel[] }>("sprefa_schema", { root }) };
  }
  return railSchemaMemo.schema;
}

// Row values in file-typed columns are repo-relative; the daemon root anchors
// them. `~` expansion mirrors the Rust side's expand() (see commands.rs).
function resolveAbs(root: string, value: string): string {
  if (value.startsWith("/")) return value;
  const base = root.startsWith("~") ? getHomeDir().replace(/\/$/, "") + root.slice(1) : root;
  return `${base.replace(/\/$/, "")}/${value}`;
}

// railChildren provider (see PanelDef in plugin.tsx): rows of the pinned
// relation, one child per distinct file(:line), clicking opens the preview.
// Every early-out returns [] so the rail shows no chevron when there's nothing
// to expand (no pin, unknown rel, no file column, empty relation).
async function sprefaRailChildren(): Promise<RailChild[]> {
  const rel = localStorage.getItem(SPREFA_RAIL_REL_KEY);
  if (!rel) return [];
  const schema = await railSchema(sprefaRoot);
  const r = schema.relations.find((x) => x.name === rel);
  if (!r) return [];
  const fileIdx = r.columns.findIndex((c) => c.ty === "file");
  if (fileIdx === -1) return [];
  const lineIdx = r.columns.findIndex((c) => c.name === "line" && c.ty === "int");
  const res = await invoke<{ rows: unknown[][] }>("sprefa_query_sql", {
    root: sprefaRoot,
    sql: `SELECT * FROM rel_${rel} LIMIT 32`,
    params: [],
  });
  const out: RailChild[] = [];
  const seen = new Set<string>();
  for (const row of res.rows) {
    const file = row[fileIdx] == null ? "" : String(row[fileIdx]);
    if (!file) continue;
    const line = lineIdx === -1 ? 0 : Number(row[lineIdx] ?? 0);
    const abs = resolveAbs(sprefaRoot, file);
    const id = `${abs}:${line}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      label: baseName(abs) + (line ? `:${line}` : ""),
      hint: abs,
      run: () => openPreviewPanel(abs, line || undefined),
    });
  }
  return out;
}

export function registerSprefa() {
  registerPlugin({
    id: "sprefa",
    panels: [
      {
        id: "sprefa",
        title: "Sprefa",
        icon: "∿",
        iconUrl: "/icons/ComputerFind_32x32_4.png",
        iconLabel: "Sprefa",
        html: "",
        component: SprefaPanelV2,
        railChildren: sprefaRailChildren,
      },
    ],
  });
}
