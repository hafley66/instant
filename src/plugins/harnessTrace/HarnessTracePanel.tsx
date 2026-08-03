// harness-trace panel: every interactive agent session across the four
// harnesses (claude/opencode/codex/kimi), enriched from the ~/.agent/mail
// dispatch ledger when it exists. Bridge-free: invokes generated commands
// directly (cass-plugin precedent). Refresh = mount (panel show) + an fs-watch
// leg on the mail dir; no polling loops.
import { useCallback, useEffect, useState } from "react";
import type { SortingState } from "@tanstack/react-table";
import { invoke } from "../../generated/native";
import { claimFsWatch } from "../../fsWatch";
import { getHomeDir, relTime } from "../../core";
import { readPluginState, savePluginState } from "../../pluginState";
import { TreeTable, type TreeColumn } from "../../treetable";
import type { DirListing } from "../../state";
import type { CassSwarmStatus } from "../cass/0_types";
import { enrichRows, parseMailNdjson, parseMailRegistry } from "./0_mail";
import type { HarnessTraceRow, HarnessTraceSeed, MailEnvelope, MailRegistry } from "./0_types";

const PLUGIN_ID = "harness-trace";
const MAIL_DIR = "~/.agent/mail";
const DEFAULT_SORT: SortingState = [{ id: "last", desc: true }];

interface TraceState {
  sorting?: SortingState;
}

let cassTraceHandler: ((row: HarnessTraceRow) => void) | null = null;

const COLUMNS: TreeColumn<HarnessTraceRow>[] = [
  {
    id: "dot",
    header: "",
    cell: (r) => <span className={"dot" + (r.status === "live" ? " on" : "")} />,
  },
  {
    id: "harness",
    header: "harness",
    cell: (r) => <span className="s-proc">{r.harness}</span>,
    sortValue: (r) => r.harness,
  },
  {
    id: "session",
    header: "session",
    cell: (r) => (
      <span className="s-name" title={r.sessionId}>
        {r.sessionId}
      </span>
    ),
    sortValue: (r) => r.sessionId,
  },
  {
    id: "from",
    header: "from",
    cell: (r) => r.from,
    sortValue: (r) => r.from,
  },
  {
    id: "why",
    header: "why",
    cell: (r) => (r.why ? <span title={r.why}>{r.why}</span> : null),
    sortValue: (r) => r.why,
  },
  {
    id: "status",
    header: "status",
    cell: (r) => <span className="s-meta">{r.status}</span>,
    sortValue: (r) => r.status,
  },
  {
    id: "last",
    header: "activity",
    cell: (r) => <span title={r.lastActivity}>{relTime(Date.parse(r.lastActivity) || 0)}</span>,
    sortValue: (r) => r.lastActivity,
  },
  {
    id: "cwd",
    header: "cwd",
    cell: (r) =>
      r.cwd ? (
        <span className="s-pwd" title={r.cwd}>
          {r.cwd}
        </span>
      ) : null,
    sortValue: (r) => r.cwd,
  },
  {
    id: "trace",
    header: "",
    noRowClick: true,
    cell: (r) => (
      <span className="wt-actions">
        <button
          className="wt-act"
          title="query CASS swarm status for this session's cwd"
          onClick={(e) => {
            e.stopPropagation();
            cassTraceHandler?.(r);
          }}
        >
          trace
        </button>
      </span>
    ),
  },
];

function traceFilter(r: HarnessTraceRow, q: string): boolean {
  const s = q.toLowerCase();
  return (
    r.harness.includes(s) ||
    r.sessionId.toLowerCase().includes(s) ||
    r.from.toLowerCase().includes(s) ||
    r.why.toLowerCase().includes(s) ||
    r.status.includes(s) ||
    r.cwd.toLowerCase().includes(s)
  );
}

// Missing mail dir = zero enrichment, zero errors (the bus is not built yet).
export async function loadMailLedger(): Promise<{ envelopes: MailEnvelope[]; registry: MailRegistry }> {
  let listing: DirListing;
  try {
    listing = await invoke<DirListing>("list_dir", { path: MAIL_DIR });
  } catch {
    return { envelopes: [], registry: {} };
  }
  const envelopes: MailEnvelope[] = [];
  let registry: MailRegistry = {};
  for (const entry of listing.entries) {
    if (entry.is_dir) continue;
    if (entry.name === "registry.json") {
      const text = await invoke<string>("read_text", { path: entry.path }).catch(() => "");
      registry = parseMailRegistry(text);
    } else if (entry.name.endsWith(".ndjson")) {
      const text = await invoke<string>("read_text", { path: entry.path }).catch(() => "");
      envelopes.push(...parseMailNdjson(text));
    }
  }
  return { envelopes, registry };
}

export function HarnessTracePanel() {
  const [rows, setRows] = useState<HarnessTraceRow[]>([]);
  const [error, setError] = useState("");
  const [cassLine, setCassLine] = useState("");
  const [sorting, setSorting] = useState<SortingState>(
    () => readPluginState<TraceState>(PLUGIN_ID, {}).sorting ?? DEFAULT_SORT,
  );

  const load = useCallback(() => {
    invoke<HarnessTraceSeed[]>("harness_trace_rows")
      .then(async (seeds) => {
        const mail = await loadMailLedger();
        // Subagent children belong in the dock strip's tree, never top-level
        // here (tree law): drop parented rows from this flat table.
        setRows(enrichRows(seeds, mail.envelopes, mail.registry).filter((r) => !r.parentId));
        setError("");
      })
      .catch((reason: unknown) => setError(String(reason)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Live leg: watch the mail dir only when it exists (list_dir probes that);
  // the claim is released on panel dispose.
  useEffect(() => {
    let release: (() => void) | null = null;
    let disposed = false;
    void invoke<DirListing>("list_dir", { path: MAIL_DIR })
      .then(() => claimFsWatch(MAIL_DIR, () => load(), false))
      .then((releaseClaim) => {
        if (disposed) releaseClaim();
        else release = releaseClaim;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      release?.();
    };
  }, [load]);

  // Module-level handler variable (tablepanels.tsx bridge precedent) so the
  // module-level column defs can reach this instance's state setters.
  useEffect(() => {
    cassTraceHandler = (row) => {
      const cwd = row.cwd.startsWith("~") ? getHomeDir() + row.cwd.slice(1) : row.cwd;
      setCassLine(`cass: querying ${row.sessionId}…`);
      void invoke<CassSwarmStatus>("cass_swarm_status", { cwd })
        .then((snapshot) => {
          const agents = snapshot.summary?.active_agent_count ?? 0;
          setCassLine(`cass ${row.sessionId}: ${snapshot.status ?? "ok"} · ${agents} agents`);
        })
        .catch((reason: unknown) => setCassLine(`cass: ${String(reason)}`));
    };
    return () => {
      cassTraceHandler = null;
    };
  }, []);

  const onSortingChange = (next: SortingState) => {
    setSorting(next);
    savePluginState<TraceState>(PLUGIN_ID, { sorting: next });
  };

  return (
    <div className="v2-panel" data-testid="harness-trace">
      <div className="act-bar">
        <span className="spy-title">harness trace</span>
        <span className="wt-count">{rows.length ? `${rows.length} sessions` : ""}</span>
        <span className="spy-spacer" />
        <button type="button" onClick={load}>
          refresh
        </button>
      </div>
      {cassLine ? <div className="act-status">{cassLine}</div> : null}
      {error ? (
        <div className="session-empty">{error}</div>
      ) : (
        <div className="panel-scroll">
          {rows.length === 0 ? (
            <div className="session-empty">no harness sessions found</div>
          ) : (
            <TreeTable<HarnessTraceRow>
              columns={COLUMNS}
              data={rows}
              getRowId={(r) => `${r.harness}:${r.sessionId}`}
              virtual
              sorting={sorting}
              onSortingChange={onSortingChange}
              controls
              filter={traceFilter}
              searchPlaceholder="filter sessions…"
              rowTitle={(r) => r.why || r.cwd}
            />
          )}
        </div>
      )}
    </div>
  );
}
