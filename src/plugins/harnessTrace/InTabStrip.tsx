// In-tab strip of EXTERNAL agent shells: claude code's own TUI already lists
// this tab's claude session and its native subagents at the bottom of the tab,
// so this bar renders only what that list cannot — the opencode/codex/kimi
// sessions and tmux lanes this terminal reaches — as one more section under it.
// Rows come from the same lazy who-called-who index the trace page uses
// (indexAgentTree/materializeAgentTree), so a branch costs nothing until its
// twisty opens. A row click joins its tmux session and pushes an agent-session
// view; the mail action pushes that agent's queue, which replaces the table
// while it is the router's top. The auto-height, 240px-capped scroll area
// reports its height changes up to the host so the xterm refits.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ExpandedState } from "@tanstack/react-table";
import { invoke } from "../../generated/native";
import { store } from "../../state";
import { TreeTable, type TreeColumn } from "../../treetable";
import { COLUMNS, stripFilter, useAgentTree } from "./DockStripShared";
import { indexAgentTree, materializeAgentTree, type AgentTreeNode } from "./0_tree";
import { openSession } from "./DockStripPanel";
import { termViewRouter, pushMailPreview } from "./3_router";
import { MailPreview } from "./4_MailPreview";
import { Waterfall } from "./4_Waterfall";
import { mailAgentIdFor } from "./0_mail";
import { StripPolicy } from "./0_strip";
import type { ITermStripEntry, StripScope } from "./0_types";

export interface InTabStripProps {
  sid: string;
  onLayout: () => void;
}

const STYLE =
  ".term-strip{flex:none;display:flex;flex-direction:column;min-height:0;max-height:240px;overflow-y:auto;background:var(--panel-bg);color:var(--panel-fg);border-top:var(--frame-w) solid var(--frame)}" +
  ".term-strip .tt-wrap{height:auto}" +
  ".term-strip .strip-back{align-self:center;border:1px solid var(--frame);background:var(--panel-bg)}" +
  ".term-strip .spy-viewing{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
  ".term-strip .strip-empty{padding:6px 8px}" +
  ".term-strip .act-bar{min-height:20px;padding:0 4px;gap:4px}" +
  ".term-strip .act-check{align-items:center}" +
  ".term-strip .tt-wrap{font-size:11px}" +
  ".term-strip td,.term-strip th{padding:0 4px;line-height:16px}" +
  // Virtual rows need the wrap itself to scroll: height:auto above kills
  // .tt-scroll's height:100%, so cap it here (act-bar eats the other 24px).
  ".term-strip .tt-scroll{max-height:216px}";

// The toggle command's whole body (main.ts binds it to the hotkey, the e2e
// harness binds the same command): the policy decides what a press writes.
export function toggleTermStripFor(sid: string): void {
  const entry = store.get().termStrip[sid] ?? null;
  store.set({ termStrip: { ...store.get().termStrip, [sid]: StripPolicy.toggle(entry) } });
}

export function InTabStrip({ sid, onLayout }: InTabStripProps) {
  const { nodes, liveTmux, registry, error, load } = useAgentTree();
  const [, setVersion] = useState(0);
  useEffect(() => termViewRouter.subscribe(() => setVersion((v) => v + 1)), []);

  const current = termViewRouter.current(sid);
  const canGoBack = termViewRouter.canGoBack(sid);
  // null until the scope button is pressed; the policy widens an empty default.
  const [chosenScope, setChosenScope] = useState<StripScope | null>(null);
  const [expanded, setExpanded] = useState<ExpandedState>({});

  const scope = useMemo(
    () => StripPolicy.effectiveScope(nodes, sid, chosenScope),
    [nodes, sid, chosenScope],
  );
  const external = useMemo(() => StripPolicy.external(nodes, sid, scope), [nodes, sid, scope]);
  const historyNodes = useMemo(() => StripPolicy.history(nodes, sid, scope), [nodes, sid, scope]);
  const index = useMemo(() => indexAgentTree(external), [external]);
  // The search box forces every branch open (TreeTable's `true` sentinel),
  // which a lazy tree cannot honor for unmaterialized children; the filter
  // therefore reaches loaded rows only.
  const openIds = useMemo(
    () => (typeof expanded === "object" ? expanded : ({} as Record<string, boolean>)),
    [expanded],
  );
  const tree = useMemo(() => materializeAgentTree(index, openIds), [index, openIds]);

  // Per-terminal open state (Toggle Relations Strip command).
  const [entry, setEntry] = useState<ITermStripEntry | null>(() => store.get().termStrip[sid] ?? null);
  useEffect(() => {
    setEntry(store.get().termStrip[sid] ?? null);
    return store.subscribe(() => setEntry(store.get().termStrip[sid] ?? null), ["termStrip"]);
  }, [sid]);

  const showActive = entry?.showActive ?? true;
  const setShowActive = (next: boolean) =>
    store.set({
      termStrip: {
        ...store.get().termStrip,
        [sid]: StripPolicy.setActivation(store.get().termStrip[sid] ?? null, next),
      },
    });

  const visible = StripPolicy.visible(entry, index.size, !!current);
  // The xterm owes a refit exactly when this strip's rendered height moved the
  // term slot's bottom edge — appearance, disappearance, a router push/pop, a
  // taller row set. Measuring instead of listing triggers is the whole point:
  // gating on data identity (a reload's new tree) resized the pty on every
  // load, and a resize is a tmux reflow, which is how a live pane went blank.
  // 0 covers the hidden strip (this component renders null), so the mount pass
  // asks for nothing, back when it fired before the host attached the xterm.
  const stripRef = useRef<HTMLDivElement | null>(null);
  const stripHeight = useRef(0);
  useEffect(() => {
    const height = stripRef.current?.getBoundingClientRect().height ?? 0;
    if (height === stripHeight.current) return;
    stripHeight.current = height;
    onLayout();
  });

  const columns = useMemo<TreeColumn<AgentTreeNode>[]>(
    () => [
      ...COLUMNS,
      {
        id: "mail",
        header: "",
        noRowClick: true,
        cell: (r) => (
          <span className="wt-actions">
            <button
              type="button"
              className="wt-act"
              data-testid={"strip-mail-" + r.id}
              title="open this agent's mail queue"
              onClick={(e) => {
                e.stopPropagation();
                pushMailPreview(sid, mailAgentIdFor(registry, r.id));
              }}
            >
              mail
            </button>
            {r.tmuxSession && (
              <button
                type="button"
                className="wt-act"
                data-testid={"strip-kill-" + r.id}
                title={`kill tmux session ${r.tmuxSession}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void invoke("kill_session", { name: r.tmuxSession }).then(load, load);
                }}
              >
                ✕
              </button>
            )}
          </span>
        ),
      },
    ],
    [registry, sid, load],
  );

  if (!visible) return null;

  const onOpenRow = (r: AgentTreeNode) => {
    // Double-click a leaf = go there (live joins only) AND push the row as the
    // tab's current view. A row WITH children expands/collapses instead.
    openSession(r.tmuxSession, liveTmux);
    termViewRouter.push(sid, { kind: "agent-session", agentSessionId: r.id });
  };

  const openWaterfallId = (id: string) => {
    const n = nodes.find((x) => x.id === id);
    openSession(n?.tmuxSession ?? null, liveTmux);
    termViewRouter.push(sid, { kind: "agent-session", agentSessionId: id });
  };

  const viewing =
    current === null
      ? null
      : current.kind === "mail-preview"
        ? `mail: ${current.agentId}`
        : `viewing: ${current.agentSessionId}`;

  return (
    <div className="term-strip" data-testid="in-tab-strip" ref={stripRef}>
      <style>{STYLE}</style>
      <div className="act-bar">
        {canGoBack && (
          <button type="button" className="strip-back" title="back" onClick={() => termViewRouter.back(sid)}>
            ←
          </button>
        )}
        <span className="spy-title" data-testid="strip-count">
          {index.size} external shells
        </span>
        {viewing && <span className="spy-viewing">{viewing}</span>}
        <span className="spy-spacer" />
        <span className="act-check" title="uncheck to see the session history waterfall">
          <input
            type="checkbox"
            id={"showactive-" + sid}
            data-testid="strip-showactive"
            checked={showActive}
            onChange={(e) => setShowActive(e.target.checked)}
          />
          <label htmlFor={"showactive-" + sid}>Show active</label>
        </span>
        <button
          type="button"
          data-testid="strip-scope"
          title={
            scope === "related"
              ? "show every external session, including ones this terminal's cwd join missed"
              : "show only the sessions related to this terminal"
          }
          onClick={() => setChosenScope(scope === "related" ? "all" : "related")}
        >
          scope: {scope}
        </button>
        <button type="button" onClick={load}>
          refresh
        </button>
      </div>
      {current?.kind === "mail-preview" ? (
        <MailPreview agentId={current.agentId} />
      ) : !showActive ? (
        <Waterfall nodes={historyNodes} nowMs={Date.now()} onOpen={openWaterfallId} onLayout={onLayout} />
      ) : error ? (
        <div className="session-empty">{error}</div>
      ) : index.size === 0 ? (
        <div className="session-empty strip-empty" data-testid="strip-empty">
          {scope === "related"
            ? `no related sessions for tmux ${StripPolicy.tmuxNameOf(sid)} — the join is by tmux session name, so a tab opened outside tmux never matches one; widen the scope to look anyway.`
            : "no external shells: every agent session here belongs to a claude tab's own list."}
        </div>
      ) : (
        <TreeTable<AgentTreeNode>
          columns={columns}
          data={tree}
          getRowId={(r) => r.id}
          getSubRows={(r) => r.children}
          getRowCanExpand={(r) => index.hasChildren(r.id)}
          expanded={expanded}
          onExpandedChange={setExpanded}
          virtual
          controls
          filter={stripFilter}
          searchPlaceholder="filter loaded rows…"
          rowTitle={(r) => r.why || r.cwd}
          rowClass={(r) => (r.tmuxSession ? "dock-strip-row" : "dock-strip-row unjoined")}
          onRowDoubleClick={(r) => {
            if (!index.hasChildren(r.id)) onOpenRow(r);
          }}
        />
      )}
    </div>
  );
}
