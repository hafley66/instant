interface PaintLayer {
  id: number;
  type: string | null;
  x?: number | null;
  y?: number | null;
  width?: number | null;
  height?: number | null;
  visible?: boolean;
  opacity?: number;
  order?: number;
  rotate?: number | null;
  color?: string | null;
  params?: Record<string, any>;
  data?: any;
}

interface PaintDocument {
  info?: { width?: number; height?: number };
  layers?: PaintLayer[];
  data?: { id: number; data: string }[];
}

type LayerRenderer = (layer: PaintLayer, images: Map<number, string>) => string;

const esc = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const n = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

function style(layer: PaintLayer): string {
  const p = layer.params ?? {};
  const fill = p.fill === false ? "none" : p.fill_color ?? layer.color ?? "none";
  const stroke = p.border ? p.border_color ?? layer.color ?? "none" : "none";
  const width = p.border_size ?? p.size ?? 1;
  return `fill="${esc(fill)}" stroke="${esc(stroke)}" stroke-width="${n(width, 1)}" opacity="${n(layer.opacity, 100) / 100}"`;
}

function transform(layer: PaintLayer): string {
  const x = n(layer.x);
  const y = n(layer.y);
  const w = n(layer.width);
  const h = n(layer.height);
  const rotate = n(layer.rotate);
  return rotate ? ` transform="rotate(${rotate} ${x + w / 2} ${y + h / 2})"` : "";
}

const renderers: Record<string, LayerRenderer> = {
  image(layer, images) {
    const data = images.get(layer.id);
    if (!data) return "";
    return `<image href="${esc(data)}" x="${n(layer.x)}" y="${n(layer.y)}" width="${n(layer.width)}" height="${n(layer.height)}" opacity="${n(layer.opacity, 100) / 100}"${transform(layer)} />`;
  },
  line(layer) {
    return `<line x1="${n(layer.x)}" y1="${n(layer.y)}" x2="${n(layer.x) + n(layer.width)}" y2="${n(layer.y) + n(layer.height)}" stroke="${esc(layer.color ?? "#000")}" stroke-width="${n(layer.params?.size, 1)}" opacity="${n(layer.opacity, 100) / 100}" />`;
  },
  arrow(layer) {
    return `<line x1="${n(layer.x)}" y1="${n(layer.y)}" x2="${n(layer.x) + n(layer.width)}" y2="${n(layer.y) + n(layer.height)}" stroke="${esc(layer.color ?? "#000")}" stroke-width="${n(layer.params?.size, 1)}" marker-end="url(#paint-arrow)" opacity="${n(layer.opacity, 100) / 100}" />`;
  },
  rectangle(layer) {
    return `<rect x="${n(layer.x)}" y="${n(layer.y)}" width="${n(layer.width)}" height="${n(layer.height)}"${transform(layer)} ${style(layer)} />`;
  },
  ellipse(layer) {
    return `<ellipse cx="${n(layer.x) + n(layer.width) / 2}" cy="${n(layer.y) + n(layer.height) / 2}" rx="${Math.abs(n(layer.width)) / 2}" ry="${Math.abs(n(layer.height)) / 2}"${transform(layer)} ${style(layer)} />`;
  },
  polygon(layer) {
    const points = Array.isArray(layer.data)
      ? layer.data.map((p) => `${n(p.x)},${n(p.y)}`).join(" ")
      : "";
    return points ? `<polygon points="${points}"${style(layer)} />` : "";
  },
  bezier_curve(layer) {
    const d = layer.data;
    if (!d?.start || !d?.end) return "";
    const cp1 = d.cp1 ?? d.start;
    const cp2 = d.cp2 ?? d.end;
    return `<path d="M ${n(d.start.x)} ${n(d.start.y)} C ${n(cp1.x)} ${n(cp1.y)}, ${n(cp2.x)} ${n(cp2.y)}, ${n(d.end.x)} ${n(d.end.y)}" fill="none" stroke="${esc(layer.color ?? "#000")}" stroke-width="${n(layer.params?.size, 1)}" opacity="${n(layer.opacity, 100) / 100}" />`;
  },
  star(layer) {
    const p = layer.params ?? {};
    const corners = Math.max(3, Math.round(n(p.corners, 5)));
    const cx = n(layer.x) + n(layer.width) / 2;
    const cy = n(layer.y) + n(layer.height) / 2;
    const outer = Math.min(Math.abs(n(layer.width)), Math.abs(n(layer.height))) / 2;
    const inner = outer * n(p.inner_radius, 50) / 100;
    const points = Array.from({ length: corners * 2 }, (_, i) => {
      const radius = i % 2 ? inner : outer;
      const angle = -Math.PI / 2 + (i * Math.PI) / corners;
      return `${cx + Math.cos(angle) * radius},${cy + Math.sin(angle) * radius}`;
    }).join(" ");
    return `<polygon points="${points}"${style(layer)} />`;
  },
  text(layer) {
    const p = layer.params ?? {};
    const lines = Array.isArray(layer.data)
      ? layer.data.map((line) => Array.isArray(line) ? line.map((span) => span.text ?? "").join("") : String(line)).join("\n")
      : String(p.text ?? "");
    const size = n(p.size, 16);
    const family = typeof p.family === "string" ? p.family : p.family?.value ?? "sans-serif";
    const weight = p.bold ? "bold" : "normal";
    const italic = p.italic ? "italic" : "normal";
    const tspans = lines.split("\n").map((line, i) => `<tspan x="${n(layer.x)}" dy="${i ? size * 1.2 : 0}">${esc(line)}</tspan>`).join("");
    return `<text y="${n(layer.y) + size}" fill="${esc(layer.color ?? p.fill_color ?? "#000")}" font-size="${size}" font-family="${esc(family)}" font-weight="${weight}" font-style="${italic}" opacity="${n(layer.opacity, 100) / 100}"${transform(layer)}>${tspans}</text>`;
  },
};

export function paintJsonToSvg(json: string, fallbackPng?: string | null): string | null {
  try {
    const doc = JSON.parse(json) as PaintDocument;
    const width = n(doc.info?.width, 1);
    const height = n(doc.info?.height, 1);
    const images = new Map((doc.data ?? []).map((entry) => [entry.id, entry.data]));
    let unsupported = false;
    const body = (doc.layers ?? [])
      .filter((layer) => layer.visible !== false)
      .sort((a, b) => n(a.order) - n(b.order))
      .map((layer) => {
        const renderer = renderers[layer.type ?? ""];
        if (!renderer) unsupported = true;
        return renderer?.(layer, images) ?? "";
      })
      .join("");
    if (unsupported && fallbackPng) {
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image href="${esc(fallbackPng)}" width="${width}" height="${height}" /></svg>`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><marker id="paint-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#000" /></marker></defs>${body}</svg>`;
  } catch {
    return null;
  }
}
