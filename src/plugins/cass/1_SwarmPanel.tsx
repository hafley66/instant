import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "../../generated/native";
import { sessionId } from "../../core";
import { TreeTable, type TreeColumn } from "../../treetable";
import { useApp } from "../../useStore";
import type { CassSwarmRow, CassSwarmStatus } from "./0_types";
import { swarmRows } from "./0_rows";
import "./0a_CassSwarm.css";

type SwarmView = CassSwarmRow["kind"];

const COLUMNS: TreeColumn<CassSwarmRow>[] = [
  { id: "status", header: "status", size: 112, sortValue: (row) => row.status, cell: (row) => row.status, toggleExpand: true },
  { id: "title", header: "name", size: 190, sortValue: (row) => row.title, cell: (row) => row.title, tree: true, toggleExpand: true },
  { id: "detail", header: "detail", sortValue: (row) => row.detail, cell: (row) => row.detail, toggleExpand: true },
];

function workspaceCwd(active: string | null, sessions: ReturnType<typeof useApp>["sessions"], worktrees: ReturnType<typeof useApp>["worktrees"]): string | null {
  const activeSession = sessions.find((session) => sessionId(session.name) === active);
  return activeSession?.paths[0] ?? worktrees.find((worktree) => worktree.is_main)?.worktree ?? worktrees[0]?.worktree ?? null;
}

function summary(snapshot: CassSwarmStatus): string[] {
  const values = snapshot.summary;
  if (!values) return [];
  return [
    `ready ${values.ready_count ?? 0}`,
    `in progress ${values.in_progress_count ?? 0}`,
    `blocked ${values.blocked_count ?? 0}`,
    `agents ${values.active_agent_count ?? 0}`,
    `reservations ${values.active_reservation_count ?? 0}`,
    values.dirty_worktree ? "worktree dirty" : "worktree clean",
  ];
}

export function CassSwarmPanel() {
  const { active, sessions, worktrees } = useApp();
  const cwd = workspaceCwd(active, sessions, worktrees);
  const [snapshot, setSnapshot] = useState<CassSwarmStatus | null>(null);
  const [error, setError] = useState("");
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const [view, setView] = useState<SwarmView>("agent");
  const load = useCallback(() => {
    if (!cwd) {
      setSnapshot(null);
      setError("no workspace path is available from the active terminal or worktree");
      return;
    }
    void invoke<CassSwarmStatus>("cass_swarm_status", { cwd })
      .then((next) => {
        setSnapshot(next);
        setError("");
        setRefreshedAt(Date.now());
      })
      .catch((reason: unknown) => {
        setSnapshot(null);
        setError(String(reason));
        setRefreshedAt(Date.now());
      });
  }, [cwd]);
  useEffect(() => {
    load();
    const timer = window.setInterval(load, 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const rows = useMemo(() => snapshot ? swarmRows(snapshot, view) : [], [snapshot, view]);
  const summaryValues = snapshot ? summary(snapshot) : [];
  return (
    <div className="v2-panel cass-swarm-panel" data-testid="cass-swarm" data-state={error ? "error" : snapshot ? "ready" : "loading"}>
      <div className="act-bar">
        <span className="spy-title">CASS swarm</span>
        <span className="wt-count">{snapshot?.status ?? (error ? "error" : "loading")}</span>
        <span className="wt-count" title={cwd ?? ""}>{cwd ?? "no workspace"}</span>
        <span className="spy-spacer" />
        <label>view <select value={view} onChange={(event) => setView(event.target.value as SwarmView)}>
          <option value="agent">subagents</option>
          <option value="reservation">reservations</option>
          <option value="work">work</option>
          <option value="provider">providers</option>
        </select></label>
        <button type="button" onClick={load}>refresh</button>
      </div>
      {summaryValues.length ? <div className="cass-swarm-summary">{summaryValues.map((value) => <span key={value}>{value}</span>)}</div> : null}
      {snapshot?.summary?.recommended_action ? <div className="cass-swarm-summary">recommended: {snapshot.summary.recommended_action}</div> : null}
      {error ? <div className="session-empty">{error}</div> : rows.length ? (
        <div className="cass-swarm-table"><TreeTable columns={COLUMNS} data={rows} getRowId={(row) => row.id} getSubRows={(row) => row.children} defaultSorting={[{ id: "status", desc: false }]} /></div>
      ) : <div className="session-empty">no {view === "agent" ? "subagents" : view} reported by CASS</div>}
      {refreshedAt ? <div className="cass-swarm-summary">refreshed</div> : null}
    </div>
  );
}
