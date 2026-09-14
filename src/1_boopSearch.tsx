// Boop Search panel: one text box over every user/assistant turn in boop.db,
// rendered as a sortable @hafley66/grid table, flat or tree-by-chat.
import { useEffect } from "react";
import { Signal, type Signal as SignalOf } from "@hafley66/signals";
import { useSignal } from "@hafley66/signals/react";
import { createDefaultGridState, createGrid, type Grid } from "@hafley66/grid";
import { GridTable } from "@hafley66/grid/react";
import { z } from "zod";
import { combineLatest, from, of, timer } from "rxjs";
import { catchError, debounceTime, switchMap, takeWhile } from "rxjs/operators";
import { invoke } from "./generated/native";
import { setting } from "./0_persistedSetting";
import { addPreviewPanel } from "./reactdock";
import { escapeHtml } from "./core";
import { openWorktree, resumeLaunch } from "./worktrees";
import type { HarnessId } from "./harnessTypes";
import {
  searchRows,
  whenLabel,
  type BoopSearchHit,
  type BoopSearchStatus,
  type SearchRole,
  type SearchRow,
} from "./1_boopSearchRows";
import "./1_boopSearch.css";

const HARNESSES: ReadonlySet<string> = new Set<HarnessId>(["claude", "opencode", "codex", "kimi"]);
const LIMIT = 500;

const rowSchema = z.object({
  id: z.string(),
  kind: z.string(),
  name: z.string(),
  chat: z.string(),
  session: z.string(),
  harness: z.string(),
  cwd: z.string(),
  role: z.string(),
  ts: z.number(),
  lastTs: z.number(),
  turn: z.number(),
  snippet: z.string(),
  count: z.number(),
});

type Model = {
  query: SignalOf<string>;
  role: SignalOf<SearchRole>;
  tree: SignalOf<boolean>;
  hits: SignalOf<BoopSearchHit[]>;
  error: SignalOf<string>;
  status: SignalOf<BoopSearchStatus | null>;
  rows: SignalOf<SearchRow[]>;
  grid: Grid<SearchRow>;
};

let model: Model | null = null;
let syncRequested = false;
const previews = new Map<string, HTMLElement>();

function openHit(hit: BoopSearchHit) {
  const key = `boop-search:${hit.session}:${hit.turn}`;
  let el = previews.get(key);
  if (!el) {
    el = document.createElement("div");
    el.className = "fs-preview";
    previews.set(key, el);
  }
  const title = `${hit.role} · ${hit.harness} · ${hit.nickname ?? hit.session.slice(0, 8)} #${hit.turn}`;
  const meta = `${hit.session} turn ${hit.turn} · ${new Date(hit.ts).toLocaleString()}${hit.cwd ? ` · ${hit.cwd}` : ""}`;
  el.innerHTML =
    `<div class="fs-preview-meta">${escapeHtml(title)}<br><span>${escapeHtml(meta)}</span></div>` +
    `<pre class="code-plain">${escapeHtml(hit.said)}</pre>`;
  addPreviewPanel(key, title, el, "right");
}

function resumeChat(row: SearchRow) {
  if (!row.cwd || !HARNESSES.has(row.harness)) return;
  openWorktree(row.cwd, "", row.cwd, resumeLaunch(row.harness as HarnessId, row.session), true);
}

type Cell = { row: { original: SearchRow } };

const columns: Grid<SearchRow>["columns"] = [
  { id: "__expand", header: "" },
  {
    id: "chat",
    accessorKey: "chat",
    header: "chat",
    cell: ({ row }: Cell) => {
      const r = row.original;
      return (
        <span
          className={`boop-search-chat${r.cwd && HARNESSES.has(r.harness) ? " boop-search-link" : ""}`}
          title={r.cwd ? `${r.cwd}\n${r.session}\ndouble-click: resume` : r.session}
          onDoubleClick={() => resumeChat(r)}
        >
          {r.chat}
          {r.kind === "chat" ? <span className="boop-search-count">{r.count}</span> : null}
        </span>
      );
    },
  },
  { id: "harness", accessorKey: "harness", header: "harness" },
  {
    id: "role",
    accessorKey: "role",
    header: "role",
    cell: ({ row }: Cell) => (row.original.kind === "chat" ? "" : row.original.role),
  },
  {
    id: "ts",
    accessorKey: "ts",
    header: "said",
    cell: ({ row }: Cell) => <span title={new Date(row.original.ts).toLocaleString()}>{whenLabel(row.original.ts)}</span>,
  },
  {
    id: "lastTs",
    accessorKey: "lastTs",
    header: "last activity",
    cell: ({ row }: Cell) => (
      <span title={new Date(row.original.lastTs).toLocaleString()}>{whenLabel(row.original.lastTs)}</span>
    ),
  },
  {
    id: "turn",
    accessorKey: "turn",
    header: "turn",
    cell: ({ row }: Cell) => (row.original.kind === "chat" ? "" : row.original.turn),
  },
  {
    id: "snippet",
    accessorKey: "snippet",
    header: "text",
    cell: ({ row }: Cell) => {
      const r = row.original;
      if (!r.hit) return "";
      const hit = r.hit;
      return (
        <span className="boop-search-snippet boop-search-link" title="click: open the full turn" onClick={() => openHit(hit)}>
          {r.snippet}
        </span>
      );
    },
  },
];

function modelFor(): Model {
  if (model) return model;
  const query = Signal("");
  const role = setting<SearchRole>("boopSearchRole", "all");
  const tree = setting<boolean>("boopSearchTree", true);
  const hits = Signal<BoopSearchHit[]>([]);
  const error = Signal("");
  const status = Signal<BoopSearchStatus | null>(null);
  const rows = Signal<SearchRow[]>(() => searchRows(hits.$(), tree.$()));
  const grid = createGrid<SearchRow>({
    schema: rowSchema as z.ZodType<SearchRow>,
    rows,
    columnDefs: columns,
    mode: "client",
    state: Signal(
      createDefaultGridState({
        sorting: [{ id: "lastTs", desc: true }],
        pagination: { pageIndex: 0, pageSize: 100_000 },
      }),
    ),
    getRowId: (row) => row.id,
    getSubRows: (row) => row.children,
    getRowCanExpand: (row) => row.kind === "chat",
  });
  model = { query, role, tree, hits, error, status, rows, grid };
  return model;
}

function statusLine(status: BoopSearchStatus | null, hits: number, query: string): string {
  if (!status) return "index: …";
  if (status.error) return `index error: ${status.error}`;
  const size = `${status.indexedTurns.toLocaleString()} turns indexed`;
  if (status.building) {
    return `indexing ${status.sessionsDone}/${status.sessionsTotal} chats · ${size}`;
  }
  if (!query.trim()) return `${size} (user + assistant)`;
  return `${hits}${hits >= LIMIT ? "+" : ""} hits · ${size}`;
}

export function BoopSearchPanel() {
  const m = modelFor();
  const query = useSignal(m.query.$);
  const role = useSignal(m.role.$);
  const tree = useSignal(m.tree.$);
  const hits = useSignal(m.hits.$);
  const error = useSignal(m.error.$);
  const status = useSignal(m.status.$);

  useEffect(() => {
    const subscription = combineLatest([m.query.$, m.role.$])
      .pipe(
        debounceTime(150),
        switchMap(([q, r]) =>
          q.trim()
            ? from(invoke<BoopSearchHit[]>("boop_search", { query: q, role: r, limit: LIMIT })).pipe(
                catchError((failure: unknown) => {
                  m.error.$(String(failure));
                  return of([] as BoopSearchHit[]);
                }),
              )
            : of([] as BoopSearchHit[]),
        ),
      )
      .subscribe((rows) => {
        m.hits.$(rows);
        if (rows.length) m.error.$("");
      });
    return () => subscription.unsubscribe();
  }, [m]);

  useEffect(() => {
    const start = syncRequested
      ? from(invoke<BoopSearchStatus>("boop_search_status"))
      : from(invoke<BoopSearchStatus>("boop_search_sync"));
    syncRequested = true;
    const subscription = start
      .pipe(
        switchMap(() => timer(0, 1000).pipe(switchMap(() => from(invoke<BoopSearchStatus>("boop_search_status"))))),
        takeWhile((s) => s.building, true),
        catchError((failure: unknown) => of({ indexedTurns: 0, sessionsDone: 0, sessionsTotal: 0, building: false, error: String(failure), updatedMs: 0 })),
      )
      .subscribe((s) => {
        m.status.$(s);
        if (!s.building && m.query.$().trim()) m.query.$(m.query.$());
      });
    return () => subscription.unsubscribe();
  }, [m]);

  return (
    <div className="v2-panel boop-search-panel">
      <div className="boop-toolbar boop-search-toolbar">
        <input
          className="boop-search-input"
          type="search"
          placeholder="search every chat (words, case-insensitive, prefix match)"
          value={query}
          autoFocus
          onChange={(e) => m.query.$(e.target.value)}
        />
        <span className="boop-search-roles">
          {(["all", "user", "assistant"] as SearchRole[]).map((value) => (
            <label key={value}>
              <input type="radio" name="boop-search-role" checked={role === value} onChange={() => m.role.$(value)} />
              {value === "assistant" ? "bot" : value}
            </label>
          ))}
        </span>
        <label>
          <input type="checkbox" checked={tree} onChange={(e) => m.tree.$(e.target.checked)} />
          tree by chat
        </label>
        <button
          type="button"
          disabled={status?.building ?? false}
          onClick={() => {
            syncRequested = false;
            void invoke<BoopSearchStatus>("boop_search_sync").then((s) => m.status.$(s));
          }}
        >
          reindex
        </button>
        <span className="muted boop-search-status">{error || statusLine(status, hits.length, query)}</span>
      </div>
      <div className="boop-search-grid">
        <GridTable grid={m.grid} density="compact" />
      </div>
    </div>
  );
}
