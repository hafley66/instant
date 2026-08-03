// dock-strip panel (CONTRACT2): the "who called who" tree rendered as a bottom
// dock strip. It is a thin host over the shared AgentStripTable (columns, data
// path, click-to-open) in DockStripShared.tsx; the bottom-group placement,
// open/closed toggle, and height persistence live in reactdock's strip helper
// (toggleStripPanel). Both this panel and the in-tab strip open a joined tmux
// session through the same bridge (openSession).
import { useCallback, useEffect, useRef, useState } from "react";
import type { SortingState } from "@tanstack/react-table";
import { invoke } from "../../generated/native";
import { readPluginState, savePluginState } from "../../pluginState";
import { claimFsWatch } from "../../fsWatch";
import { AgentStripTable, useAgentTree, type AgentTreeState } from "./DockStripShared";
import type { AgentTreeNode } from "./0_tree";

export interface DockStripBridge {
  onOpen: (sessionName: string) => void;
}

let dockStripBridge: DockStripBridge | null = null;
export function setDockStrip(bridge: DockStripBridge) {
  dockStripBridge = bridge;
}

// Click = go there: open the joined tmux session through the bridge both strips
// share. No-op for unjoined rows (bridge not called).
export function openSession(sessionName: string) {
  dockStripBridge?.onOpen(sessionName);
}

const PLUGIN_ID = "dock-strip";
const MAIL_DIR = "~/.agent/mail";

interface StripState {
  sorting?: SortingState;
}

// The dock strip's live leg: watch the mail dir and reload rows when it changes.
// Uses a ref so the fs-watch release is tied to this panel's lifetime.
function useMailLiveLeg(load: () => void) {
  useEffect(() => {
    let releaseClaim: (() => void) | null = null;
    let disposed = false;
    void invoke<{ entries: { is_dir: boolean; name: string; path: string }[] }>("list_dir", {
      path: MAIL_DIR,
    })
      .then(() => claimFsWatch(MAIL_DIR, load, false))
      .then((claim) => {
        if (disposed) claim();
        else releaseClaim = claim;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      releaseClaim?.();
    };
  }, [load]);
}

export function DockStripPanel() {
  const { tree, error, load } = useAgentTree();
  const [sorting, setSorting] = useState<SortingState>(
    () => readPluginState<StripState>(PLUGIN_ID, {}).sorting ?? [],
  );
  // Keep a stable ref to the latest load so the fs-watch never re-subscribes.
  const loadRef = useRef(load);
  loadRef.current = load;
  const loadStable: AgentTreeState["load"] = useCallback(
    () => loadRef.current(),
    [],
  );
  useMailLiveLeg(loadStable);

  const onSortingChange = (next: SortingState) => {
    setSorting(next);
    savePluginState<StripState>(PLUGIN_ID, { sorting: next });
  };

  const onRowClick = (r: AgentTreeNode) => {
    // Click = go there: only rows joined to a tmux session open it. Unjoined
    // rows are a no-op (no error, no toast).
    if (r.tmuxSession) openSession(r.tmuxSession);
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
