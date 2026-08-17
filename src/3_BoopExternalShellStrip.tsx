import { useEffect, useMemo, useRef, useState } from "react";
import { boopAgents, type LaneRow } from "./boopAgents";
import { store } from "./state";
import { TreeTable, type TreeColumn } from "./treetable";
import { openExternalShell } from "./plugins/harnessTrace/DockStripPanel";
import type { ITermStripEntry } from "./plugins/harnessTrace/0_types";
import { liveExternalShellRows } from "./0_externalShells";

export interface BoopExternalShellStripProps {
  sid: string;
  onLayout: () => void;
}

const STYLE =
  ".term-strip{flex:none;display:flex;flex-direction:column;min-height:0;max-height:240px;overflow-y:auto;background:var(--panel-bg);color:var(--panel-fg);border-top:var(--frame-w) solid var(--frame)}" +
  ".term-strip .tt-wrap{height:auto;font-size:11px}" +
  ".term-strip td,.term-strip th{padding:0 4px;line-height:16px}" +
  ".term-strip .tt-scroll{max-height:216px}";

const COLUMNS: TreeColumn<LaneRow>[] = [
  { id: "lane", header: "external shell", tree: true, cell: (row) => <span className="s-name">{row.lane}</span>, sortValue: (row) => row.lane },
  { id: "harness", header: "harness", cell: (row) => <span className="s-meta">{row.harness}</span>, sortValue: (row) => row.harness },
  { id: "state", header: "state", cell: (row) => <span className={`agents-state ${row.state}`}>{row.state}</span>, sortValue: (row) => row.state },
  { id: "target", header: "target", cell: (row) => <span className="s-meta">{row.tmux}</span>, sortValue: (row) => row.tmux },
];

export function BoopExternalShellStrip({ sid, onLayout }: BoopExternalShellStripProps) {
  const [entry, setEntry] = useState<ITermStripEntry | null>(() => store.get().termStrip[sid] ?? null);
  const [filter, setFilter] = useState("");
  const stripRef = useRef<HTMLDivElement | null>(null);
  const stripHeight = useRef(0);
  useEffect(() => {
    setEntry(store.get().termStrip[sid] ?? null);
    return store.subscribe(() => setEntry(store.get().termStrip[sid] ?? null), ["termStrip"]);
  }, [sid]);
  const rows = useMemo(() => liveExternalShellRows(boopAgents.$().tree), [boopAgents.$().tree]);
  useEffect(() => {
    const height = stripRef.current?.getBoundingClientRect().height ?? 0;
    if (height === stripHeight.current) return;
    stripHeight.current = height;
    onLayout();
  });
  if (entry?.open !== true) return null;
  return (
    <div className="term-strip" data-testid="boop-external-shell-strip" ref={stripRef}>
      <style>{STYLE}</style>
      <div className="act-bar">
        <span className="spy-title">external shells · boop</span>
        <span className="wt-count">{rows.length} live</span>
      </div>
      {rows.length === 0 ? <div className="session-empty strip-empty">no live Boop shell targets</div> : (
        <TreeTable
          columns={COLUMNS}
          data={rows}
          getRowId={(row) => row.id}
          query={filter}
          onQueryChange={setFilter}
          filter={(row, query) => `${row.lane} ${row.harness} ${row.tmux}`.toLowerCase().includes(query.toLowerCase())}
          controls
          searchPlaceholder="filter external shells…"
          rowTitle={(row) => `${row.lane} → ${row.tmux}`}
          onRowDoubleClick={(row) => openExternalShell(row.lane, row.tmux)}
        />
      )}
    </div>
  );
}
