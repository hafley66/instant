// Status is the first Signals/RxJS vertical slice. The application runtime owns
// polling; this component is only a SignalReact + canonical TreeTable renderer.
import { SignalReact } from "@hafley66/signals/react";
import { registerStatus, type StatusReport } from "./plugin";
import { TreeTable, type TreeColumn } from "./treetable";
import { queryGhcacheSnapshot } from "./ghcacheSnapshot";
import { runtimePorts } from "./reactive/ports";
import { sprefaRoot, statusRows, type StatusRow } from "./reactive/statusModel";

const STATUS_COLUMNS: TreeColumn<StatusRow>[] = [
  {
    id: "service",
    header: "service",
    sortValue: (row) => row.label,
    cell: (row) => (
      <div className="status-row">
        <div className="status-head">
          <span className={`status-dot s-${row.report.state}`} />
          <span className="status-label">{row.label}</span>
          <span className="status-state">{row.report.state}</span>
        </div>
        {row.report.detail ? <div className="status-detail">{row.report.detail}</div> : null}
        {row.report.links?.length ? (
          <div className="status-links">
            {row.report.links.map((link) => (
              <button
                type="button"
                className="status-link"
                key={link.label + link.path}
                title={link.path}
                onClick={() => runtimePorts.open(link).catch(console.error)}
              >
                {link.reveal ? "⊙ " : "↗ "}
                {link.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    ),
  },
];

export const StatusPanelV2 = SignalReact(function StatusPanelV2() {
  const rows = statusRows.$();
  return (
    <div className="v2-panel status-panel">
      <div className="act-bar">
        <span className="spy-title">status</span>
        <span className="spy-spacer" />
      </div>
      <div className="panel-scroll">
        {!rows.length ? (
          <div className="session-empty">no status probes</div>
        ) : (
          <TreeTable columns={STATUS_COLUMNS} data={rows} getRowId={(row) => row.id} />
        )}
      </div>
    </div>
  );
});

// ---- built-in probes ----

const HOME = "/Users/chrishafley"; // for default-path links (opener wants absolute)

async function ghcacheProbe(): Promise<StatusReport> {
  // Status checks only the daemon transport. Local scan fallback belongs to
  // the explicit Worktrees refresh path; doing it on this 4-second poll was
  // the old git-status volley in a new disguise.
  const snapshot = await queryGhcacheSnapshot();
  if (snapshot.error === "http") {
    return {
      state: "degraded",
      detail: `:7748 · HTTP ${snapshot.httpStatus}`,
      links: ghcacheLinks(),
    };
  }
  if (snapshot.error) {
    return { state: "down", detail: ":7748 unreachable", links: ghcacheLinks() };
  }
  return {
    state: "up",
    detail: `:7748 · ${snapshot.rows.length} worktree${snapshot.rows.length === 1 ? "" : "s"}`,
    links: ghcacheLinks(),
  };
}

function ghcacheLinks() {
  return [
    { label: "db", path: `${HOME}/.local/share/ghcache/gh.db`, reveal: true },
    { label: "ghcacher repo", path: `${HOME}/projects/ghcacher`, reveal: true },
  ];
}

async function sprefaProbe(): Promise<StatusReport> {
  const root = sprefaRoot.$();
  try {
    const ping = await runtimePorts.invoke<{ program?: string; program_files?: string[] }>("sprefa_ping", {
      root,
    });
    const files = ping.program_files?.length
      ? ping.program_files
      : [ping.program].filter(Boolean as unknown as (v: string | undefined) => v is string);
    return {
      state: "up",
      detail: `${files.length} program file${files.length === 1 ? "" : "s"}`,
      links: files.map((f) => ({ label: f.split("/").pop() ?? f, path: f })),
    };
  } catch (e) {
    return { state: "down", detail: String(e) };
  }
}

async function tmuxProbe(): Promise<StatusReport> {
  const sessions = await runtimePorts.invoke<unknown[]>("list_sessions");
  return {
    state: sessions.length ? "up" : "idle",
    detail: `${sessions.length} session${sessions.length === 1 ? "" : "s"}`,
  };
}

async function cdpProbe(): Promise<StatusReport> {
  const up = await runtimePorts.invoke<boolean>("cdp_status");
  return up ? { state: "up", detail: "engine attached" } : { state: "idle", detail: "not started" };
}

// claude/opencode running directly on a terminal, outside any tmux session —
// "degraded" (not "down") because nothing's broken, it's just untracked.
async function rogueProbe(): Promise<StatusReport> {
  const rogue = await runtimePorts.invoke<{ pid: number; command: string; cwd: string | null }[]>(
    "rogue_agent_sessions",
  );
  if (!rogue.length) return { state: "idle", detail: "none" };
  const detail = rogue
    .slice(0, 3)
    .map((r) => `${r.command} pid ${r.pid}${r.cwd ? ` ${r.cwd}` : ""}`)
    .join(" · ");
  return { state: "degraded", detail: `${rogue.length} off-tmux: ${detail}` };
}

let builtinDone = false;
export function registerBuiltinStatus() {
  if (builtinDone) return;
  builtinDone = true;
  registerStatus({ id: "ghcache", label: "ghcache daemon", check: ghcacheProbe });
  registerStatus({ id: "sprefa", label: "sprefa daemon", check: sprefaProbe });
  registerStatus({ id: "tmux", label: "tmux sessions", check: tmuxProbe });
  registerStatus({ id: "cdp", label: "browser engine", check: cdpProbe });
  registerStatus({ id: "rogue", label: "rogue agent shells", check: rogueProbe });
}
