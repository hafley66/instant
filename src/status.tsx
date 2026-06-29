// Status panel (v2): one row per registered StatusProbe, polled on an interval.
// Probes carry their own check() logic (fetch a port, invoke a command, stat a
// file), so this file is purely presentational + the polling loop. Built-in
// probes for the services instant talks to live at the bottom and self-register
// via registerBuiltinStatus(), called once from main.ts.
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { statusProbes, registerStatus, type StatusReport, type StatusState } from "./plugin";

const POLL_MS = 4000;
const GHCACHE_BASE = "http://127.0.0.1:7748";

// Worst-first ranking. The rail dot reflects the worst state across all probes,
// so an unreachable daemon turns the rail item red even while others are green.
const RANK: Record<StatusState, number> = {
  down: 0,
  degraded: 1,
  unknown: 2,
  idle: 3,
  up: 4,
};

function worst(reports: StatusReport[]): StatusState {
  let s: StatusState = "up";
  for (const r of reports) if (RANK[r.state] < RANK[s]) s = r.state;
  return reports.length ? s : "unknown";
}

// Push the aggregate health onto the rail button so CSS can tint its glyph.
function paintRail(state: StatusState) {
  const btn = document.getElementById("status-toggle");
  if (btn) btn.dataset.health = state;
}

type Row = { id: string; label: string; report: StatusReport };

export function StatusPanelV2() {
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    let alive = true;
    async function tick() {
      const probes = statusProbes();
      const reports = await Promise.all(
        probes.map(async (p): Promise<Row> => {
          try {
            return { id: p.id, label: p.label, report: await p.check() };
          } catch (e) {
            return {
              id: p.id,
              label: p.label,
              report: { state: "down", detail: String(e) },
            };
          }
        }),
      );
      if (!alive) return;
      setRows(reports);
      paintRail(worst(reports.map((r) => r.report)));
    }
    tick();
    const h = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, []);

  return (
    <div className="v2-panel status-panel">
      <div className="act-bar">
        <span className="spy-title">status</span>
        <span className="spy-spacer" />
      </div>
      <div className="panel-scroll">
        {rows.length === 0 ? (
          <div className="session-empty">no status probes</div>
        ) : (
          rows.map((r) => (
            <div className="status-row" key={r.id}>
              <div className="status-head">
                <span className={`status-dot s-${r.report.state}`} />
                <span className="status-label">{r.label}</span>
                <span className="status-state">{r.report.state}</span>
              </div>
              {r.report.detail ? <div className="status-detail">{r.report.detail}</div> : null}
              {r.report.links?.length ? (
                <div className="status-links">
                  {r.report.links.map((l) => (
                    <button
                      type="button"
                      className="status-link"
                      key={l.label + l.path}
                      title={l.path}
                      onClick={() =>
                        (l.reveal ? revealItemInDir(l.path) : openPath(l.path)).catch(
                          console.error,
                        )
                      }
                    >
                      {l.reveal ? "⊙ " : "↗ "}
                      {l.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ---- built-in probes ----

const HOME = "/Users/chrishafley"; // for default-path links (opener wants absolute)

async function ghcacheProbe(): Promise<StatusReport> {
  try {
    const res = await fetch(`${GHCACHE_BASE}/worktrees`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) {
      return { state: "degraded", detail: `:7748 · HTTP ${res.status}`, links: ghcacheLinks() };
    }
    const rows = (await res.json()) as unknown[];
    return {
      state: "up",
      detail: `:7748 · ${rows.length} worktree${rows.length === 1 ? "" : "s"}`,
      links: ghcacheLinks(),
    };
  } catch {
    return { state: "down", detail: ":7748 unreachable", links: ghcacheLinks() };
  }
}

function ghcacheLinks() {
  return [
    { label: "db", path: `${HOME}/.local/share/ghcache/gh.db`, reveal: true },
    { label: "ghcacher repo", path: `${HOME}/projects/ghcacher`, reveal: true },
  ];
}

async function sprefaProbe(): Promise<StatusReport> {
  const root = localStorage.getItem("sprefa.root") ?? "~/projects/sprefa/v5";
  try {
    const ping = await invoke<{ program?: string; program_files?: string[] }>("sprefa_ping", {
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
  const sessions = await invoke<unknown[]>("list_sessions");
  return {
    state: sessions.length ? "up" : "idle",
    detail: `${sessions.length} session${sessions.length === 1 ? "" : "s"}`,
  };
}

async function cdpProbe(): Promise<StatusReport> {
  const up = await invoke<boolean>("cdp_status");
  return up ? { state: "up", detail: "engine attached" } : { state: "idle", detail: "not started" };
}

let builtinDone = false;
export function registerBuiltinStatus() {
  if (builtinDone) return;
  builtinDone = true;
  registerStatus({ id: "ghcache", label: "ghcache daemon", check: ghcacheProbe });
  registerStatus({ id: "sprefa", label: "sprefa daemon", check: sprefaProbe });
  registerStatus({ id: "tmux", label: "tmux sessions", check: tmuxProbe });
  registerStatus({ id: "cdp", label: "browser engine", check: cdpProbe });
}
