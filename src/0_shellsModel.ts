// Pure display model for the Shells (boop) panel: formatters + per-column cell
// values. No grid, no React, no tauri — so it stays unit-testable in node. The
// panel (1_shellsPanel.tsx) renders these values; the grid keeps its own numeric
// accessors for sorting. Row shapes come from the shared boop data source.
import type { AgentsRow } from "./boopAgents";

export function fmtKb(kb: number | null): string {
  if (kb === null) return "";
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)}M` : `${kb}K`;
}

export function fmtCpu(cpu: number | null): string {
  return cpu === null ? "" : `${cpu.toFixed(1)}%`;
}

export function fmtUptime(sec: number | null): string {
  if (sec === null) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

// Display string for a plain-text shells column. Special columns (dot, state,
// hail) are rendered by the panel, not here.
export function shellCell(row: AgentsRow, columnId: string): string {
  switch (columnId) {
    case "lane":
      return row.lane;
    case "harness":
      return "harness" in row ? row.harness : "";
    case "model":
      return "model" in row ? (row.model ?? "") : "";
    case "tmux":
      return "tmux" in row ? (row.tmux ?? "") : "";
    case "cwd":
      return "cwd" in row ? (row.cwd ?? "") : "";
    case "pid":
      return "pid" in row && row.pid !== null ? String(row.pid) : "";
    case "rss":
      return "rssKb" in row ? fmtKb(row.rssKb) : "";
    case "cpu":
      return "cpuPct" in row ? fmtCpu(row.cpuPct) : "";
    case "uptime":
      return "uptimeSec" in row ? fmtUptime(row.uptimeSec) : "";
    default:
      return "";
  }
}
