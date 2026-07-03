import type { TextLayer } from "./meme";
import { TreeTable, type TreeColumn } from "./treetable";

interface MemeLayersProps {
  layers: TextLayer[];
  activeLayerId: string;
  onChange: (layers: TextLayer[]) => void;
  onActivate: (id: string) => void;
}

const MAX_LAYERS = 10;

const DEFAULT_LAYER: TextLayer = {
  id: "new",
  text: "",
  size: 48,
  fill: "#ffffff",
  stroke: "#000000",
  strokeWidth: 4,
  caps: true,
  xPct: 0.5,
  yPct: 0.5,
};

function updateLayer(
  layers: TextLayer[],
  id: string,
  patch: Partial<TextLayer>,
): TextLayer[] {
  return layers.map((l) => (l.id === id ? { ...l, ...patch } : l));
}

function moveLayer(layers: TextLayer[], id: string, dir: -1 | 1): TextLayer[] {
  const idx = layers.findIndex((l) => l.id === id);
  if (idx < 0) return layers;
  const next = idx + dir;
  if (next < 0 || next >= layers.length) return layers;
  const copy = [...layers];
  [copy[idx], copy[next]] = [copy[next], copy[idx]];
  return copy;
}

function removeLayer(layers: TextLayer[], id: string): TextLayer[] {
  if (layers.length <= 1) return layers;
  return layers.filter((l) => l.id !== id);
}

function addLayer(layers: TextLayer[]): TextLayer[] {
  if (layers.length >= MAX_LAYERS) return layers;
  const last = layers[layers.length - 1] ?? DEFAULT_LAYER;
  const id = `layer-${Date.now()}`;
  return [...layers, { ...last, id, text: "", xPct: 0.5, yPct: 0.5 }];
}

export function MemeLayers({
  layers,
  activeLayerId,
  onChange,
  onActivate,
}: MemeLayersProps) {
  const columns: TreeColumn<TextLayer>[] = [
    {
      id: "idx",
      header: "#",
      cell: (l) => String(layers.findIndex((x) => x.id === l.id) + 1),
      noRowClick: true,
    },
    {
      id: "text",
      header: "text",
      tree: true,
      cell: (l) => (
        <input
          className="meme-layer-text"
          value={l.text}
          onChange={(e) =>
            onChange(updateLayer(layers, l.id, { text: e.currentTarget.value }))
          }
          onClick={(e) => e.stopPropagation()}
        />
      ),
      noRowClick: true,
    },
    {
      id: "size",
      header: "size",
      cell: (l) => (
        <input
          type="range"
          min={12}
          max={128}
          value={l.size}
          className="meme-layer-size"
          onChange={(e) =>
            onChange(updateLayer(layers, l.id, { size: Number(e.currentTarget.value) }))
          }
          onClick={(e) => e.stopPropagation()}
        />
      ),
      noRowClick: true,
    },
    {
      id: "fill",
      header: "fill",
      cell: (l) => (
        <input
          type="color"
          value={l.fill}
          className="meme-layer-color"
          onChange={(e) =>
            onChange(updateLayer(layers, l.id, { fill: e.currentTarget.value }))
          }
          onClick={(e) => e.stopPropagation()}
        />
      ),
      noRowClick: true,
    },
    {
      id: "stroke",
      header: "stroke",
      cell: (l) => (
        <input
          type="color"
          value={l.stroke}
          className="meme-layer-color"
          onChange={(e) =>
            onChange(updateLayer(layers, l.id, { stroke: e.currentTarget.value }))
          }
          onClick={(e) => e.stopPropagation()}
        />
      ),
      noRowClick: true,
    },
    {
      id: "width",
      header: "W",
      cell: (l) => (
        <input
          type="range"
          min={0}
          max={16}
          value={l.strokeWidth}
          className="meme-layer-width"
          onChange={(e) =>
            onChange(
              updateLayer(layers, l.id, { strokeWidth: Number(e.currentTarget.value) }),
            )
          }
          onClick={(e) => e.stopPropagation()}
        />
      ),
      noRowClick: true,
    },
    {
      id: "caps",
      header: "caps",
      cell: (l) => (
        <input
          type="checkbox"
          checked={l.caps}
          onChange={(e) =>
            onChange(updateLayer(layers, l.id, { caps: e.currentTarget.checked }))
          }
          onClick={(e) => e.stopPropagation()}
        />
      ),
      noRowClick: true,
    },
    {
      id: "x",
      header: "x",
      cell: (l) => (
        <input
          type="number"
          min={0}
          max={100}
          value={Math.round(l.xPct * 100)}
          className="meme-layer-pos"
          onChange={(e) =>
            onChange(updateLayer(layers, l.id, { xPct: Number(e.currentTarget.value) / 100 }))
          }
          onClick={(e) => e.stopPropagation()}
        />
      ),
      noRowClick: true,
    },
    {
      id: "y",
      header: "y",
      cell: (l) => (
        <input
          type="number"
          min={0}
          max={100}
          value={Math.round(l.yPct * 100)}
          className="meme-layer-pos"
          onChange={(e) =>
            onChange(updateLayer(layers, l.id, { yPct: Number(e.currentTarget.value) / 100 }))
          }
          onClick={(e) => e.stopPropagation()}
        />
      ),
      noRowClick: true,
    },
    {
      id: "up",
      header: "",
      cell: (l) => {
        const idx = layers.findIndex((x) => x.id === l.id);
        return (
          <button
            type="button"
            disabled={idx === 0}
            onClick={() => onChange(moveLayer(layers, l.id, -1))}
          >
            ▲
          </button>
        );
      },
      noRowClick: true,
    },
    {
      id: "down",
      header: "",
      cell: (l) => {
        const idx = layers.findIndex((x) => x.id === l.id);
        return (
          <button
            type="button"
            disabled={idx === layers.length - 1}
            onClick={() => onChange(moveLayer(layers, l.id, 1))}
          >
            ▼
          </button>
        );
      },
      noRowClick: true,
    },
    {
      id: "del",
      header: "",
      cell: (l) => (
        <button type="button" onClick={() => onChange(removeLayer(layers, l.id))}>
          ×
        </button>
      ),
      noRowClick: true,
    },
  ];

  return (
    <div className="meme-layers-panel">
      <div className="meme-layers-bar">
        <span>layers</span>
        <button
          type="button"
          disabled={layers.length >= MAX_LAYERS}
          onClick={() => onChange(addLayer(layers))}
        >
          + add
        </button>
      </div>
      <TreeTable<TextLayer>
        columns={columns}
        data={layers}
        getRowId={(l) => l.id}
        onRowClick={(l) => onActivate(l.id)}
        rowClass={(l) => (l.id === activeLayerId ? "meme-layer-active" : undefined)}
      />
    </div>
  );
}
