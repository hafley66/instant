import { useEffect, useMemo, useState } from "react";
import type { TreeColumn } from "./treetable";
import { TreeTable } from "./treetable";
import type { MemeCaption, PaintBridge } from "./paintBridge";
import { readPluginState, savePluginState } from "./pluginState";

type CaptionRow = MemeCaption & { label: string };
type PaintCaptionUi = { captionsCollapsed?: boolean };
const blank = (id: CaptionRow["id"], label: string): CaptionRow => ({ id, label, enabled: true, text: "", family: "Impact", size: 56, bold: false, italic: false, underline: false, strikethrough: false, fill: "#ffffff", stroke: "#000000", strokeWidth: 4 });
const stop = (event: React.MouseEvent) => event.stopPropagation();

export function PaintMemeControls({ bridge }: { bridge: PaintBridge | null }) {
  const [rows, setRows] = useState<CaptionRow[]>(() => [blank("top", "top"), blank("bottom", "bottom")]);
  const [error, setError] = useState("");
  const [collapsed, setCollapsed] = useState(() => readPluginState<PaintCaptionUi>("paint", {}).captionsCollapsed ?? false);
  const update = (id: CaptionRow["id"], patch: Partial<MemeCaption>) => setRows((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
  const columns = useMemo<TreeColumn<CaptionRow>[]>(() => [
    { id: "enabled", header: "on", noRowClick: true, cell: (row) => <button type="button" className={`paint-caption-enabled${row.enabled ? " on" : ""}`} aria-label={`${row.label} enabled`} aria-pressed={row.enabled} onClick={(event) => { stop(event); update(row.id, { enabled: !row.enabled }); }}>{row.enabled ? "✓" : "○"}</button> },
    { id: "position", header: "position", tree: true, cell: (row) => row.label },
    { id: "text", header: "text", noRowClick: true, cell: (row) => <input aria-label={`${row.label} text`} value={row.text} onClick={stop} onChange={(event) => update(row.id, { text: event.currentTarget.value })} /> },
    { id: "font", header: "font", noRowClick: true, cell: (row) => <select aria-label={`${row.label} font family`} value={row.family} onClick={stop} onChange={(event) => update(row.id, { family: event.currentTarget.value })}><option>Impact</option><option>Arial</option><option>Helvetica</option><option>Verdana</option><option>Times New Roman</option></select> },
    { id: "size", header: "size", noRowClick: true, cell: (row) => <input aria-label={`${row.label} font size`} type="number" min="8" max="400" value={row.size} onClick={stop} onChange={(event) => update(row.id, { size: Number(event.currentTarget.value) })} /> },
    ...(["bold", "italic", "underline", "strikethrough"] as const).map((key) => ({ id: key, header: key === "strikethrough" ? "strike" : key, noRowClick: true, cell: (row: CaptionRow) => <input aria-label={`${row.label} ${key}`} type="checkbox" checked={row[key]} onClick={stop} onChange={(event) => update(row.id, { [key]: event.currentTarget.checked })} /> })),
    { id: "fill", header: "fill", noRowClick: true, cell: (row) => <input aria-label={`${row.label} fill color`} type="color" value={row.fill} onClick={stop} onChange={(event) => update(row.id, { fill: event.currentTarget.value })} /> },
    { id: "stroke", header: "stroke", noRowClick: true, cell: (row) => <input aria-label={`${row.label} stroke color`} type="color" value={row.stroke} onClick={stop} onChange={(event) => update(row.id, { stroke: event.currentTarget.value })} /> },
    { id: "width", header: "stroke px", noRowClick: true, cell: (row) => <input aria-label={`${row.label} stroke width`} type="number" min="0" max="32" value={row.strokeWidth} onClick={stop} onChange={(event) => update(row.id, { strokeWidth: Number(event.currentTarget.value) })} /> },
  ], []);
  useEffect(() => {
    if (!bridge) return;
    const timer = window.setTimeout(() => {
      void bridge.syncMemeCaptions(rows).then(() => setError("")).catch((cause) => setError(String(cause)));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [bridge, rows]);
  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    savePluginState<PaintCaptionUi>("paint", { captionsCollapsed: next });
  };
  return <aside className={`paint-meme-controls${collapsed ? " collapsed" : ""}`} data-testid="meme-captions"><div className="meme-layers-bar"><span>meme captions</span><button type="button" title={collapsed ? "expand captions" : "collapse captions"} onClick={toggleCollapsed}>{collapsed ? "▲" : "▼"}</button></div>{collapsed ? null : <><TreeTable columns={columns} data={rows} getRowId={(row) => row.id} rowClass={(row) => `paint-caption-${row.id}`} />{error ? <output className="paint-caption-error">{error}</output> : null}</>}</aside>;
}
