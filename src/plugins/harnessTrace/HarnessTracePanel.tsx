// harness-trace panel: every interactive agent session across the four
// harnesses (claude/opencode/codex/kimi) as a who-called-who tree, enriched
// from the ~/.agent/mail dispatch ledger when it exists. Bridge-free: invokes
// generated commands directly (cass-plugin precedent). Refresh = mount (panel
// show) + an fs-watch leg on the mail dir; no polling loops. Children
// materialize per expanded branch (indexAgentTree/materializeAgentTree), so the
// row model is roots-sized until a twisty opens.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ExpandedState, SortingState } from "@tanstack/react-table";
import { invoke } from "../../generated/native";
import { claimFsWatch } from "../../fsWatch";
import { getHomeDir, relTime } from "../../core";
import { readPluginState, savePluginState } from "../../pluginState";
import { TreeTable, type TreeColumn } from "../../treetable";
import type { DirListing } from "../../state";
import type { CassSwarmStatus } from "../cass/0_types";
import { MAIL_DIR } from "./0_live";
import { MailDirectory } from "./0_bus";
import { enrichRows, parseMailNdjson, parseMailRegistry } from "./0_mail";
import { indexAgentTree, materializeAgentTree, toAgentNodes, type AgentTreeNode } from "./0_tree";
import type {
  AgentSessionNode,
  HarnessTraceSeed,
  IAgentTreeIndex,
  IMailDirectory,
  MailEnvelope,
  MailRegistry,
} from "./0_types";

const PLUGIN_ID = "harness-trace";
const DEFAULT_SORT: SortingState = [{ id: "last", desc: true }];

interface TraceState {
  sorting?: SortingState;
}

let cassTraceHandler: ((row: AgentTreeNode) => void) | null = null;

const COLUMNS: TreeColumn<AgentTreeNode>[] = [
  {
    id: "session",
    header: "session",
    tree: true,
    cell: (r) => (
      <span className="s-name" title={r.id}>
        {r.id}
      </span>
    ),
    sortValue: (r) => r.id,
  },
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
    id: "link",
    header: "link",
    cell: (r) => <span className="s-meta">{r.parentKind ?? "—"}</span>,
    sortValue: (r) => r.parentKind ?? "",
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

function traceFilter(r: AgentTreeNode, q: string): boolean {
  const s = q.toLowerCase();
  return (
    r.harness.includes(s) ||
    r.id.toLowerCase().includes(s) ||
    r.from.toLowerCase().includes(s) ||
    r.why.toLowerCase().includes(s) ||
    (r.parentKind ?? "").includes(s) ||
    r.status.includes(s) ||
    r.cwd.toLowerCase().includes(s)
  );
}

// Missing mail dir = zero enrichment, zero errors.
export async function loadMailLedger(): Promise<{
  envelopes: MailEnvelope[];
  registry: MailRegistry;
  directory: IMailDirectory;
}> {
  let listing: DirListing;
  try {
    listing = await invoke<DirListing>("list_dir", { path: MAIL_DIR });
  } catch {
    return { envelopes: [], registry: {}, directory: {} };
  }
  const envelopes: MailEnvelope[] = [];
  let registry: MailRegistry = {};
  let directory: IMailDirectory = {};
  for (const entry of listing.entries) {
    if (entry.is_dir) continue;
    if (entry.name === "registry.json") {
      const text = await invoke<string>("read_text", { path: entry.path }).catch(() => "");
      registry = parseMailRegistry(text);
      directory = MailDirectory.parse(text);
    } else if (entry.name.endsWith(".ndjson")) {
      const text = await invoke<string>("read_text", { path: entry.path }).catch(() => "");
      envelopes.push(...parseMailNdjson(text));
    }
  }
  return { envelopes, registry, directory };
}

export function HarnessTracePanel() {
  const [nodes, setNodes] = useState<AgentSessionNode[]>([]);
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const [error, setError] = useState("");
  const [cassLine, setCassLine] = useState("");
  const [sorting, setSorting] = useState<SortingState>(
    () => readPluginState<TraceState>(PLUGIN_ID, {}).sorting ?? DEFAULT_SORT,
  );

  const load = useCallback(() => {
    invoke<HarnessTraceSeed[]>("harness_trace_rows")
      .then(async (seeds) => {
        const mail = await loadMailLedger();
        const flat = enrichRows(seeds, mail.envelopes, mail.registry);
        setNodes(toAgentNodes(flat, mail.envelopes, mail.registry));
        setError("");
      })
      .catch((reason: unknown) => setError(String(reason)));
  }, []);

  const index: IAgentTreeIndex = useMemo(() => indexAgentTree(nodes), [nodes]);
  // The search box forces every branch open (TreeTable's `true` sentinel), which
  // a lazy tree cannot honor for unmaterialized children; the filter therefore
  // reaches loaded rows only and the header says so.
  const openIds = useMemo(
    () => (typeof expanded === "object" ? expanded : ({} as Record<string, boolean>)),
    [expanded],
  );
  const tree = useMemo(() => materializeAgentTree(index, openIds), [index, openIds]);

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
      setCassLine(`cass: querying ${row.id}…`);
      void invoke<CassSwarmStatus>("cass_swarm_status", { cwd })
        .then((snapshot) => {
          const agents = snapshot.summary?.active_agent_count ?? 0;
          setCassLine(`cass ${row.id}: ${snapshot.status ?? "ok"} · ${agents} agents`);
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
        <span className="wt-count">
          {index.size ? `${tree.length} roots · ${index.size} sessions` : ""}
        </span>
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
          {index.size === 0 ? (
            <div className="session-empty">no harness sessions found</div>
          ) : (
            <TreeTable<AgentTreeNode>
              columns={COLUMNS}
              data={tree}
              getRowId={(r) => r.id}
              getSubRows={(r) => r.children}
              getRowCanExpand={(r) => index.hasChildren(r.id)}
              expanded={expanded}
              onExpandedChange={setExpanded}
              virtual
              sorting={sorting}
              onSortingChange={onSortingChange}
              controls
              filter={traceFilter}
              searchPlaceholder="filter loaded rows…"
              rowTitle={(r) => r.why || r.cwd}
            />
          )}
        </div>
      )}
    </div>
  );
}
