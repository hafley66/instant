import { clampPanZoom } from "./0_PanZoomViewport";

export type SvgBox = { x: number; y: number; width: number; height: number };

const SVG_HTML_ENTITIES: Record<string, string> = {
  nbsp: "\u00a0",
  ensp: "\u2002",
  emsp: "\u2003",
  thinsp: "\u2009",
  ndash: "\u2013",
  mdash: "\u2014",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  bull: "\u2022",
  hellip: "\u2026",
  middot: "\u00b7",
  minus: "\u2212",
  times: "\u00d7",
};
const SVG_XML_ENTITIES = new Set(["amp", "apos", "gt", "lt", "quot"]);

export function normalizeSvgEntities(source: string): string {
  return source.replace(/&([a-z][a-z0-9]+);/gi, (entity, name: string) => {
    const normalized = name.toLowerCase();
    if (SVG_XML_ENTITIES.has(normalized)) return entity;
    return SVG_HTML_ENTITIES[normalized] ?? `&amp;${name};`;
  });
}

export function svgSourceBox(source: string): SvgBox | null {
  const match = source.match(/\bviewBox\s*=\s*["']\s*([-\d.]+)[ ,]+([-\d.]+)[ ,]+([-\d.]+)[ ,]+([-\d.]+)\s*["']/i);
  if (!match) return null;
  const [, x, y, width, height] = match.map(Number);
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

export function svgNativeBox(original: SvgBox, viewportWidth: number, viewportHeight: number): SvgBox {
  const width = Math.max(1, viewportWidth);
  const height = Math.max(1, viewportHeight);
  return {
    x: original.x + (original.width - width) / 2,
    y: original.y,
    width,
    height,
  };
}

export function svgBoxAtZoom(original: SvgBox, current: SvgBox, nextZoom: number, focusX = 0.5, focusY = 0.5): SvgBox {
  const zoom = clampPanZoom(nextZoom);
  const width = original.width / zoom;
  const height = original.height / zoom;
  return {
    x: current.x + current.width * focusX - width * focusX,
    y: current.y + current.height * focusY - height * focusY,
    width,
    height,
  };
}

export function panSvgBox(box: SvgBox, deltaX: number, deltaY: number, viewportWidth: number, viewportHeight: number): SvgBox {
  return {
    ...box,
    x: box.x + deltaX * box.width / Math.max(1, viewportWidth),
    y: box.y + deltaY * box.height / Math.max(1, viewportHeight),
  };
}
