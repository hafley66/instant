// dock-strip panel (CONTRACT2): the "who called who" tree rendered as a bottom
// dock strip. It is a thin host over the shared AgentStripTable (columns, data
// path, click-to-open) in DockStripShared.tsx; the bottom-group placement,
// open/closed toggle, and height persistence live in reactdock's strip helper
// (toggleStripPanel). Both this panel and the in-tab strip open a joined tmux
// session through the same bridge (openSession).
import { useState } from "react";
import type { SortingState } from "@tanstack/react-table";
import { readPluginState, savePluginState } from "../../pluginState";
import { AgentStripTable, useAgentTree } from "./DockStripShared";
import { StripPolicy } from "./0_strip";
import type { AgentTreeNode } from "./0_tree";

export interface DockStripBridge {
  onOpen: (sessionName: string) => void;
}

let dockStripBridge: DockStripBridge | null = null;
export function setDockStrip(bridge: DockStripBridge) {
  dockStripBridge = bridge;
}

// Click = go there: open the joined tmux session through the bridge both strips
// share. The guard lives here so no host (row click, waterfall bar) can reach
// the bridge for an unjoined or dead-tmux row.
export function openSession(sessionName: string | null, liveTmux: Set<string>) {
  if (StripPolicy.openAction({ tmuxSession: sessionName }, liveTmux) !== "open") return;
  dockStripBridge?.onOpen(sessionName!);
}

const PLUGIN_ID = "dock-strip";

interface StripState {
  sorting?: SortingState;
}

export function DockStripPanel() {
  const { tree, liveTmux, error, load } = useAgentTree();
  const [sorting, setSorting] = useState<SortingState>(
    () => readPluginState<StripState>(PLUGIN_ID, {}).sorting ?? [],
  );

  const onSortingChange = (next: SortingState) => {
    setSorting(next);
    savePluginState<StripState>(PLUGIN_ID, { sorting: next });
  };

  const onRowClick = (r: AgentTreeNode) => {
    openSession(r.tmuxSession, liveTmux);
  };

  return (
    <div className="v2-panel" data-testid="dock-strip">
      <style>{".strip-unjoined{opacity:.55}.dock-strip-row td{opacity:1}.dock-strip-row.unjoined td{opacity:.55}"}</style>
      <div className="act-bar">
        <span className="spy-title">dock strip</span>
        <span className="wt-count">{tree.length ? `${tree.length} roots` : ""}</span>
        <span className="spy-spacer" />
        <button type="button" onClick={load}>
          refresh
        </button>
      </div>
      <AgentStripTable
        tree={tree}
        error={error}
        onRowClick={onRowClick}
        sorting={sorting}
        onSortingChange={onSortingChange}
        virtual
        controls
      />
    </div>
  );
}
