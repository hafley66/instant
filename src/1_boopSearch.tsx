// Boop Search panel: one text box over every user/assistant turn in boop.db,
// rendered as a sortable @hafley66/grid table, flat or tree-by-chat.
import { useEffect, useMemo } from "react";
import { Signal, type Signal as SignalOf } from "@hafley66/signals";
import { useSignal } from "@hafley66/signals/react";
import { TreeTable, type TreeColumn } from "./treetable";
import type { ColumnSizingState } from "@tanstack/react-table";
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

const HARNESSES: ReadonlySet<string> = new Set<HarnessId>(["claude", "opencode", "codex", "kimi", "omp"]);
const LIMIT = 500;

type Model = {
  query: SignalOf<string>;
  role: SignalOf<SearchRole>;
  tree: SignalOf<boolean>;
  hits: SignalOf<BoopSearchHit[]>;
  error: SignalOf<string>;
  status: SignalOf<BoopSearchStatus | null>;
  sizing: SignalOf<ColumnSizingState>;
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

function highlight(text: string, terms: string[]) {
  const words = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).filter(Boolean);
  if (!words.length) return text;
  const parts = text.split(new RegExp(`(${words.join("|")})`, "gi"));
  return parts.map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
}

let activeTerms: string[] = [];

const columns: TreeColumn<SearchRow>[] = [
  {
    id: "snippet",
    header: "message",
    tree: true,
    size: 640,
    minSize: 160,
    sortValue: (r) => r.snippet,
    cell: (r) =>
      r.hit ? (
        <span className="boop-search-text" title={`turn ${r.turn} · click: open the full turn\n\n${r.hit.said.slice(0, 1500)}`}>
          {highlight(r.snippet, activeTerms)}
        </span>
      ) : (
        <span className="boop-search-text muted">{r.count} matching messages</span>
      ),
  },
  {
    id: "chat",
    header: "chat",
    size: 160,
    sortValue: (r) => r.chat,
    cell: (r) => (
      <span
        className="boop-search-chat"
        title={`${r.harness} · ${r.session}${r.cwd ? `\n${r.cwd}\ndouble-click: resume` : ""}`}
      >
        {r.chat}
        {r.kind === "chat" ? <span className="boop-search-count">{r.count}</span> : null}
      </span>
    ),
  },
  {
    id: "role",
    header: "who",
    size: 60,
    sortValue: (r) => r.role,
    cell: (r) => (r.kind === "chat" ? "" : r.role === "assistant" ? "bot" : r.role),
  },
  {
    id: "ts",
    header: "said",
    size: 90,
    sortValue: (r) => r.ts,
    cell: (r) => <span title={new Date(r.ts).toLocaleString()}>{whenLabel(r.ts)}</span>,
  },
  {
    id: "lastTs",
    header: "chat active",
    size: 100,
    sortValue: (r) => r.lastTs,
    cell: (r) => <span title={new Date(r.lastTs).toLocaleString()}>{whenLabel(r.lastTs)}</span>,
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
  const sizing = setting<ColumnSizingState>("boopSearchSizing", {});
  model = { query, role, tree, hits, error, status, sizing };
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
  const sizing = useSignal(m.sizing.$);
  const rows = useMemo(() => searchRows(hits, tree), [hits, tree]);

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
        activeTerms = m.query.$().split(/\s+/).filter(Boolean);
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
      <div className="fs-list boop-search-grid">
        <TreeTable<SearchRow>
          columns={columns}
          data={rows}
          getRowId={(r) => r.id}
          getSubRows={(r) => r.children}
          defaultSorting={[{ id: "lastTs", desc: true }]}
          defaultExpandedAll
          virtual
          columnSizing={sizing}
          onColumnSizingChange={(next) => m.sizing.$(next)}
          onRowClick={(r) => r.hit && openHit(r.hit)}
          onRowDoubleClick={(r) => resumeChat(r)}
          rowTitle={(r) => (r.hit ? "click: open the full turn" : r.cwd ? "double-click: resume this chat" : r.session)}
        />
      </div>
    </div>
  );
}
