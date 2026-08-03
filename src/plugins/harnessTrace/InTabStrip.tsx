// In-tab relation strip (CONTRACT3): the same AgentSessionNode tree as the
// global dock strip, mounted inside a terminal tab beneath the xterm area, but
// FILTERED to the trees that contain a node joined to THIS terminal's tmux
// session. Clicking any row opens its tmux session (same bridge as the dock
// strip) and pushes an agent-session view onto that terminal's router; while
// the stack is non-empty a back button pops it and the top is shown as the
// "viewing:" header line. The auto-height, 240px-capped scroll area sits under
// the term slot and reports every appearance/resize up to the host so the
// xterm refits.
import { useEffect, useMemo, useState } from "react";
import { store } from "../../state";
import { AgentStripTable, useAgentTree } from "./DockStripShared";
import { filterForestByTmux, type AgentTreeNode } from "./0_tree";
import { openSession } from "./DockStripPanel";
import { termRouter } from "./3_router";
import { StripPolicy } from "./0_strip";
import type { ITermStripEntry } from "./0_types";

export interface InTabStripProps {
  sid: string;
  onLayout: () => void;
}

// The toggle command's whole body (main.ts binds it to the hotkey, the e2e
// harness binds the same command): the policy decides what a press writes.
export function toggleTermStripFor(sid: string): void {
  const entry = store.get().termStrip[sid] ?? null;
  store.set({ termStrip: { ...store.get().termStrip, [sid]: StripPolicy.toggle(entry) } });
}

export function InTabStrip({ sid, onLayout }: InTabStripProps) {
  const { tree, error, load } = useAgentTree();
  const [, setVersion] = useState(0);
  useEffect(() => termRouter.subscribe(() => setVersion((v) => v + 1)), []);

  const current = termRouter.current(sid);
  const canGoBack = termRouter.canGoBack(sid);
  const filtered = useMemo(() => filterForestByTmux(tree, sid), [tree, sid]);

  // Per-terminal open state (Toggle Relations Strip command).
  const [entry, setEntry] = useState<ITermStripEntry | null>(() => store.get().termStrip[sid] ?? null);
  useEffect(() => {
    setEntry(store.get().termStrip[sid] ?? null);
    return store.subscribe(() => setEntry(store.get().termStrip[sid] ?? null), ["termStrip"]);
  }, [sid]);

  const visible = StripPolicy.visible(entry, filtered.length, !!current);
  // The strip's appearance and the router's push/pop change the term-slot's
  // height, so refit the xterm whenever either changes.
  useEffect(() => {
    if (visible) onLayout();
  }, [visible, onLayout]);

  if (!visible) return null;

  const onRowClick = (r: AgentTreeNode) => {
    // Click = go there (joins only) AND push the row as the tab's current view.
    if (r.tmuxSession) openSession(r.tmuxSession);
    termRouter.push(sid, { kind: "agent-session", agentSessionId: r.id });
  };

  return (
    <div className="term-strip" data-testid="in-tab-strip">
      <style>{".term-strip{flex:none;display:flex;flex-direction:column;min-height:0;max-height:240px;overflow-y:auto;background:var(--panel-bg);color:var(--panel-fg);border-top:var(--frame-w) solid var(--frame)}.term-strip .tt-wrap{height:auto}.term-strip .strip-back{align-self:center;border:1px solid var(--frame);background:var(--panel-bg)}.term-strip .spy-viewing{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}"}</style>
      <div className="act-bar">
        {canGoBack && (
          <button type="button" className="strip-back" title="back" onClick={() => termRouter.back(sid)}>
            ←
          </button>
        )}
        <span className="spy-title">relations</span>
        {current && <span className="spy-viewing">viewing: {current.agentSessionId}</span>}
        <span className="spy-spacer" />
        <button type="button" onClick={load}>
          refresh
        </button>
      </div>
      <AgentStripTable
        tree={filtered}
        error={error}
        onRowClick={onRowClick}
        controls
      />
    </div>
  );
}
