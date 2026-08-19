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
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { SignalReact } from "@hafley66/signals/react";
import type { ExpandedState } from "@tanstack/react-table";
import { invoke } from "../../generated/native";
import { store } from "../../state";
import { TreeTable, type TreeColumn } from "../../treetable";
import { COLUMNS, invalidateAgentTreeRows, stripFilter, useAgentTree } from "./DockStripShared";
import { indexAgentTree, materializeAgentTree, type AgentTreeNode } from "./0_tree";
import { openSession } from "./DockStripPanel";
import { termViewRouter, pushMailPreview } from "./3_router";
import { MailPreview } from "./4_MailPreview";
import { Waterfall } from "./4_Waterfall";
import { mailAgentIdFor } from "./0_mail";
import { StripPolicy } from "./0_strip";
import type { ITermStripEntry, StripScope } from "./0_types";
import { useLiveProbeRender } from "../../1_LiveProbe";
import { focusedFamilyQuery, useBoopFamily } from "./1_boopFamily";
import { FocusedBoopNetwork } from "../../1c_FocusedBoopNetwork";

export interface InTabStripProps {
  sid: string;
  onLayout: () => void;
  resizable?: boolean;
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
  ".focused-family-strip{height:100%;flex:1 1 auto;max-height:none}" +
  // Virtual rows need the wrap itself to scroll: height:auto above kills
  // .tt-scroll's height:100%, so cap it here (act-bar eats the other 24px).
  ".term-strip .tt-scroll{max-height:216px}";
const FAMILY_GRAPH_STYLE = ".boop-family-graph{background:#10141c}.focused-family-table{height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden}.focused-family-grid{min-height:0;flex:1}.focused-family-grid .tt-wrap{height:100%}.focused-family-grid .tt-scroll{max-height:none}.focused-family-table td,.focused-family-table th{height:30px;line-height:19px}.focused-family-table td:first-child b,.focused-family-table td:first-child small{display:block;overflow:hidden;text-overflow:ellipsis}.family-network-viz{flex:0 1 160px;min-height:72px;overflow:auto;background:#0d121a;border-bottom:1px solid var(--frame)}.family-network-viz svg{display:block;width:100%;min-width:720px;font:11px ui-monospace,monospace}.family-network-viz text{fill:#aab3bf}.family-lane{stroke:color-mix(in srgb,var(--frame) 55%,transparent)}.family-edge{fill:none;stroke:#6688b8;stroke-width:1.5}.family-node{fill:#8aa8cf}.family-node.live{fill:#55b57a}.family-node.dead{fill:#d05b5b}.family-node.done{fill:#6d87aa}.family-mark{opacity:.9}.family-mark.send{fill:#d59b47}.family-mark.receive{fill:#3f8dbd}.family-mark.work{fill:#49a56b}.family-mark.error{fill:#d05050}.family-waterfall{position:relative;width:100%;height:12px;background:color-mix(in srgb,var(--frame) 22%,transparent)}.family-phase{position:absolute;top:1px;height:10px;min-width:2px}.family-phase.send{background:#d59b47}.family-phase.receive{background:#3f8dbd}.family-phase.work{background:#49a56b}.family-phase.error{background:#d05050}.boop-family-linked{background:rgba(74,127,223,.24)!important}";
const NO_RESUME_TABS: Record<string, { sessionId?: string }> = {};

// The toggle command's whole body (main.ts binds it to the hotkey, the e2e
// harness binds the same command): the policy decides what a press writes.
export function toggleTermStripFor(sid: string): void {
  const entry = store.get().termStrip[sid] ?? null;
  const next = StripPolicy.toggle(entry);
  if (next.open) invalidateAgentTreeRows();
  store.set({ termStrip: { ...store.get().termStrip, [sid]: next } });
}

export function toggleFamilyStripFor(sid: string): void {
  const entries = store.get().termStrip;
  const entry = entries[sid] ?? null;
  const alreadyOpen = entry?.open === true && entry.family === true;
  if (!alreadyOpen) invalidateAgentTreeRows();
  store.set({
    termStrip: {
      ...entries,
      [sid]: { open: !alreadyOpen, showActive: false, network: false, family: true },
    },
  });
}

// Summon the strip open and flip the network (waterfall) view on it, so the
// diagram is reachable even when the strip has zero related rows.
export function toggleNetworkFor(sid: string): void {
  const entries = store.get().termStrip;
  const entry = entries[sid] ?? null;
  const next = !(entry?.network);
  store.set({
    termStrip: {
      ...entries,
      [sid]: { open: true, showActive: entry?.showActive ?? true, network: next },
    },
  });
}

function InTabStripView({ sid, onLayout, resizable = false }: InTabStripProps) {
  const [, setVersion] = useState(0);
  useEffect(() => termViewRouter.subscribe(() => setVersion((v) => v + 1)), []);

  const current = termViewRouter.current(sid);
  const canGoBack = termViewRouter.canGoBack(sid);
  // null until the scope button is pressed; the policy widens an empty default.
  const [chosenScope, setChosenScope] = useState<StripScope | null>(null);
  const [expanded, setExpanded] = useState<ExpandedState>({});

  // Per-terminal open state (Toggle Relations Strip command).
  const [entry, setEntry] = useState<ITermStripEntry | null>(() => store.get().termStrip[sid] ?? null);
  useEffect(() => {
    setEntry(store.get().termStrip[sid] ?? null);
    return store.subscribe(() => setEntry(store.get().termStrip[sid] ?? null), ["termStrip"]);
  }, [sid]);

  // An absent entry is the auto-appear state: load enough data to decide
  // whether related rows exist. Only an explicit dismissal suspends the feed.
  const dataEnabled = entry?.open !== false || current !== null;
  const familyMode = entry?.family ?? false;
  const externalResumeTabs = useSyncExternalStore(
    useCallback(
      (notify: () => void) => familyMode ? () => {} : store.subscribe(notify, ["resumeTabs"]),
      [familyMode],
    ),
    () => familyMode ? NO_RESUME_TABS : store.get().resumeTabs,
  );
  const nativeSessionId = externalResumeTabs[StripPolicy.tmuxNameOf(sid)]?.sessionId ?? null;
  const familyQuery = useMemo(
    () => (familyMode ? focusedFamilyQuery(StripPolicy.tmuxNameOf(sid)) : null),
    [familyMode, sid],
  );
  const family = useBoopFamily(familyQuery);
  const { nodes, liveTmux, registry, error, load } = useAgentTree(dataEnabled);

  const networkView = entry?.network ?? false;
  useLiveProbeRender("InTabStrip", sid, { networkView, nodeCount: nodes.length });
  const setNetwork = (next: boolean) =>
    store.set({
      termStrip: {
        ...store.get().termStrip,
        [sid]: {
          ...(store.get().termStrip[sid] ?? { open: true, showActive: true }),
          open: true,
          network: next,
        },
      },
    });

  const scope = useMemo(
    () => StripPolicy.effectiveScope(nodes, sid, chosenScope, nativeSessionId),
    [nodes, sid, chosenScope, nativeSessionId],
  );
  const external = useMemo(
    () => StripPolicy.external(nodes, sid, scope, nativeSessionId),
    [nodes, sid, scope, nativeSessionId],
  );
  const historyNodes = useMemo(
    () => StripPolicy.history(nodes, sid, scope, nativeSessionId),
    [nodes, sid, scope, nativeSessionId],
  );
  const familyNodes = useMemo(() => {
    const metadata = new Map(nodes.map((node) => [node.id, node]));
    return family.nodes.map((node) => {
      const trace = metadata.get(node.id);
      if (!trace) return node;
      return {
        ...node,
        model: node.model ?? trace.model ?? null,
        provider: node.provider ?? trace.provider ?? null,
        preset: node.preset ?? trace.preset ?? null,
        tokens: node.tokens ?? trace.tokens ?? null,
      };
    });
  }, [family.nodes, nodes]);
  useEffect(() => {
    if (familyMode && familyNodes.length > 0) {
      setExpanded(Object.fromEntries(familyNodes.map((node) => [node.id, true])));
    }
  }, [familyMode, familyNodes.length]);
  const showActive = entry?.showActive ?? true;
  const visibleNodes = familyMode ? familyNodes : showActive ? external : historyNodes;
  const index = useMemo(() => indexAgentTree(visibleNodes), [visibleNodes]);
  // The search box forces every branch open (TreeTable's `true` sentinel),
  // which a lazy tree cannot honor for unmaterialized children; the filter
  // therefore reaches loaded rows only.
  const openIds = useMemo(
    () => (typeof expanded === "object" ? expanded : ({} as Record<string, boolean>)),
    [expanded],
  );
  const tree = useMemo(() => {
    const value = materializeAgentTree(index, openIds);
    return value;
  }, [index, openIds]);

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
    if (resizable) return;
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
    <div className={resizable ? "term-strip focused-family-strip" : "term-strip"} data-testid="in-tab-strip" ref={stripRef}>
      <style>{STYLE}</style>
      <style>{FAMILY_GRAPH_STYLE}</style>
      <div className="act-bar">
        {canGoBack && (
          <button type="button" className="strip-back" title="back" onClick={() => termViewRouter.back(sid)}>
            ←
          </button>
        )}
        <span className="spy-title" data-testid="strip-count">
          {index.size} {familyMode ? "family sessions" : showActive ? "external shells" : "sessions"}
        </span>
        {viewing && <span className="spy-viewing">{viewing}</span>}
        <span className="spy-spacer" />
        {!familyMode && <span className="act-check" title="check for active shells only; uncheck to include session history">
          <input
            type="checkbox"
            id={"showactive-" + sid}
            data-testid="strip-showactive"
            checked={showActive}
            onChange={(e) => setShowActive(e.target.checked)}
          />
          <label htmlFor={"showactive-" + sid}>Show active</label>
        </span>}
        {!familyMode && <button
          type="button"
          data-testid="strip-network-toggle"
          title={networkView ? "show table view" : "show network view"}
          onClick={() => setNetwork(!networkView)}
        >
          {networkView ? "table" : "network"}
        </button>}
        {!familyMode && <button
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
        </button>}
        <button type="button" onClick={familyMode ? family.load : load}>
          refresh
        </button>
      </div>
      {current?.kind === "mail-preview" ? (
        <MailPreview agentId={current.agentId} />
      ) : (familyMode ? family.error : error) ? (
        <div className="session-empty">{familyMode ? family.error : error}</div>
      ) : networkView ? (
        <Waterfall nodes={visibleNodes} nowMs={Date.now()} onOpen={openWaterfallId} onLayout={onLayout} />
      ) : index.size === 0 ? (
        <div className="session-empty strip-empty" data-testid="strip-empty">
          {familyMode
            ? "no focused family sessions in the last seven days"
            : scope === "related"
            ? `no related sessions for tmux ${StripPolicy.tmuxNameOf(sid)} — the join is by tmux session name, so a tab opened outside tmux never matches one; widen the scope to look anyway.`
            : "no external shells: every agent session here belongs to a claude tab's own list."}
        </div>
      ) : (
        familyMode ? <FocusedBoopNetwork nodes={visibleNodes} /> : <TreeTable<AgentTreeNode>
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

export const InTabStrip = SignalReact(InTabStripView);
