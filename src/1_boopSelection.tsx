// The tmux rail's secondary dropdown: a most-recently-viewed checkbox list of
// Boop-controlled live sessions, with persisted selection and bulk send. Rendered
// as the sessions panel's PanelDef.railContent into the expandable rail child
// area (rail.ts). Rows reuse the canonical TreeTable grid (AGENTS: no bespoke
// lists). The component owns its polling; it never rewrites rail state, so a
// data refresh never rebuilds the rail or clears the compose box.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TreeTable, type TreeColumn } from "./treetable";
import { openTab } from "./terminal";
import {
  clearSelection,
  formatRecentFocus,
  listSelection,
  onSelectionRefresh,
  setSelection,
  shoutSelection,
  type BoopSelectionRow,
} from "./0_boopSelection";
import "./1_boopSelection.css";

// `pending` is local UI state for an in-flight `selection set`, so the checkbox
// disables while the write is outstanding without a second store.
interface SelRow extends BoopSelectionRow {
  pending?: boolean;
}

// The grid columns are module-stable (rebuilt columns reset tanstack sort state);
// cells reach the live handlers through this per-mount bridge, mirroring the
// tmuxBridge/PinCell pattern in tablepanels.tsx.
interface SelBridge {
  toggle: (row: SelRow) => void;
  // True while any mutation is outstanding; the grid disables checkboxes so a
  // toggle cannot interleave with Clear or Send.
  busy: boolean;
}

let selBridge: SelBridge | null = null;

const SEL_COLUMNS: TreeColumn<SelRow>[] = [
  {
    id: "check",
    header: "",
    noRowClick: true,
    size: 26,
    cell: (r) => (
      <input
        type="checkbox"
        className="bs-check"
        checked={r.selected}
        disabled={r.pending || (selBridge?.busy ?? false)}
        aria-label={`select ${r.route}`}
        onChange={() => selBridge?.toggle(r)}
      />
    ),
  },
  {
    id: "session",
    header: "session",
    sortValue: (r) => r.session,
    cell: (r) => (
      <button
        type="button"
        className="bs-session"
        title={r.session}
        onClick={() => openTab(r.session)}
      >
        {r.session}
      </button>
    ),
  },
  { id: "route", header: "route", sortValue: (r) => r.route, cell: (r) => r.route },
  { id: "title", header: "title", sortValue: (r) => r.title, cell: (r) => r.title },
  {
    id: "focus",
    header: "focus",
    sortValue: (r) => r.lastFocusedAt ?? 0,
    size: 60,
    cell: (r) => formatRecentFocus(r.lastFocusedAt, Date.now()),
  },
];

const POLL_MS = 4000;

// Draft survives a rail rebuild: expanding an unrelated rail panel unmounts and
// remounts this component (rail.ts replaces #actbar-panels wholesale), and an
// unsent message must not vanish with it. Module-level (one rail) rather than
// pluginState, since it is transient and needs no on-disk persistence.
let draftBody = "";

export function BoopSelectionPanel() {
  const [rows, setRows] = useState<SelRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [body, setBodyState] = useState(draftBody);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [busyWrites, setBusyWrites] = useState(0);
  const inFlight = useRef(false);
  const busyWritesRef = useRef(0);
  const sendingRef = useRef(false);
  // Every mutation bumps the generation; a list response that started before the
  // bump is discarded, so a slow poll cannot overwrite an optimistic selection.
  const mutationGen = useRef(0);
  const refreshQueued = useRef(false);

  const setBody = useCallback((value: string) => {
    draftBody = value;
    setBodyState(value);
  }, []);

  // Clears the draft only when it is still what was sent: text typed while the
  // request was in flight is preserved.
  const clearSentDraft = useCallback((sent: string) => {
    setBodyState((cur) => {
      if (cur !== sent) return cur;
      draftBody = "";
      return "";
    });
  }, []);

  const refresh = useCallback(async () => {
    // A poll during a write (or while another poll is in flight) is deferred,
    // not dropped: the follow-up run reads the post-write persisted state.
    if (busyWritesRef.current > 0 || inFlight.current) {
      refreshQueued.current = true;
      return;
    }
    const gen = mutationGen.current;
    inFlight.current = true;
    try {
      const next = await listSelection();
      if (mutationGen.current !== gen) return; // a write started after this read
      setRows(next);
      setError(null);
    } catch (e) {
      if (mutationGen.current === gen) setError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current = false;
      if (refreshQueued.current) {
        refreshQueued.current = false;
        void refresh();
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    const off = onSelectionRefresh(() => void refresh());
    return () => {
      window.clearInterval(timer);
      off();
    };
  }, [refresh]);

  // All writes serialize: a checkbox, Clear, and Send never overlap, so no two
  // mutations race for the same persisted selection.
  const beginWrite = useCallback(() => {
    mutationGen.current++;
    busyWritesRef.current++;
    setBusyWrites(busyWritesRef.current);
  }, []);
  const endWrite = useCallback(() => {
    busyWritesRef.current = Math.max(0, busyWritesRef.current - 1);
    setBusyWrites(busyWritesRef.current);
    if (busyWritesRef.current === 0) void refresh();
  }, [refresh]);

  const toggle = useCallback(
    (row: SelRow) => {
      if (busyWritesRef.current > 0 || sendingRef.current) return;
      const next = !row.selected;
      beginWrite();
      setRows((prior) =>
        prior?.map((r) => (r.route === row.route ? { ...r, selected: next, pending: true } : r)) ?? prior,
      );
      void setSelection(row.route, next)
        .then(() =>
          setRows((prior) =>
            prior?.map((r) => (r.route === row.route ? { ...r, pending: false } : r)) ?? prior,
          ),
        )
        .catch((e) => {
          setRows((prior) =>
            prior?.map((r) => (r.route === row.route ? { ...r, selected: row.selected, pending: false } : r)) ?? prior,
          );
          setError(e instanceof Error ? e.message : String(e));
        })
        .finally(endWrite);
    },
    [beginWrite, endWrite],
  );

  const bridge = useMemo<SelBridge>(
    () => ({ toggle, busy: busyWrites > 0 || sending }),
    [toggle, busyWrites, sending],
  );
  useEffect(() => {
    selBridge = bridge;
    return () => {
      if (selBridge === bridge) selBridge = null;
    };
  }, [bridge]);

  const count = useMemo(() => (rows ?? []).filter((r) => r.selected).length, [rows]);

  const send = useCallback(() => {
    // Snapshot the displayed eligible routes at click: explicit recipients, not
    // a broad shout. No send without an explicit click, a body, and a free lane.
    const snapshot = (rows ?? []).filter((r) => r.selected).map((r) => r.route);
    const text = body;
    if (!snapshot.length || !text.trim() || sendingRef.current || busyWritesRef.current > 0) return;
    sendingRef.current = true;
    beginWrite();
    setSending(true);
    setSendError(null);
    setResult(null);
    void shoutSelection(snapshot, text)
      .then((out) => {
        setResult(out.trim() || `sent to ${snapshot.length}`);
        // Selection is a reusable group: it stays checked after a send. Only the
        // sent draft clears, and only if it is unchanged.
        clearSentDraft(text);
      })
      .catch((e) => setSendError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        sendingRef.current = false;
        setSending(false);
        endWrite();
      });
  }, [rows, body, beginWrite, endWrite, clearSentDraft]);

  const clear = useCallback(() => {
    if (busyWritesRef.current > 0 || sendingRef.current) return;
    setBody("");
    beginWrite();
    void clearSelection()
      .then(() => setRows((prior) => prior?.map((r) => ({ ...r, selected: false })) ?? prior))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(endWrite);
  }, [beginWrite, endWrite, setBody]);

  const composerBusy = sending || busyWrites > 0;

  return (
    <div className="bs-panel">
      {error ? (
        <div className="bs-error" role="alert">
          {error}
        </div>
      ) : null}
      {rows === null && !error ? (
        <div className="bs-status">loading…</div>
      ) : rows && rows.length === 0 ? (
        <div className="bs-status">no live Boop sessions</div>
      ) : rows ? (
        <TreeTable<SelRow>
          columns={SEL_COLUMNS}
          data={rows}
          getRowId={(r) => r.route}
          defaultSorting={[{ id: "focus", desc: true }]}
        />
      ) : null}
      <div className="bs-compose">
        <textarea
          className="bs-body"
          rows={2}
          placeholder="message to selected…"
          value={body}
          readOnly={sending}
          onChange={(e) => setBody(e.target.value)}
        />
        <div className="bs-actions">
          <button
            type="button"
            className="bs-send"
            disabled={composerBusy || count === 0 || !body.trim()}
            onClick={send}
          >
            {sending ? "sending…" : `Send to selected (${count})`}
          </button>
          <button type="button" className="bs-clear" disabled={composerBusy} onClick={clear}>
            Clear
          </button>
        </div>
        {result ? <div className="bs-result">{result}</div> : null}
        {sendError ? (
          <div className="bs-error" role="alert">
            {sendError}
          </div>
        ) : null}
      </div>
    </div>
  );
}