import type { IDisposable, Terminal } from "@xterm/xterm";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import mermaidBundleUrl from "mermaid/dist/mermaid.min.js?url";
import { DiagramLightbox, diagramSvgMarkup } from "./mdview/0_DiagramLightbox";
import { renderD2 } from "./mdview/d2";

type DiagramLanguage = "mermaid" | "d2";
type DiagramFence = { language: DiagramLanguage; code: string; start: number; end: number; inferred: boolean };
type LogicalLine = { text: string; start: number; end: number };
export type TerminalDiagramLayout = {
  maxViewportHeightRatio: number;
  maxBlankRows: number;
};
export const defaultTerminalDiagramLayout: TerminalDiagramLayout = {
  maxViewportHeightRatio: 0.45,
  maxBlankRows: 18,
};
let mermaidId = 0;
type MermaidApi = typeof import("mermaid").default;
let mermaidPromise: Promise<MermaidApi> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  const loaded = (window as typeof window & { mermaid?: MermaidApi }).mermaid;
  if (loaded) return Promise.resolve(loaded);
  if (mermaidPromise) return mermaidPromise;
  mermaidPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = mermaidBundleUrl;
    script.addEventListener("load", () => {
      const api = (window as typeof window & { mermaid?: MermaidApi }).mermaid;
      if (api) resolve(api);
      else reject(new Error("Mermaid bundle loaded without its global API"));
    });
    script.addEventListener("error", () => reject(new Error("Mermaid bundle failed to load")));
    document.head.appendChild(script);
  });
  return mermaidPromise;
}

function logicalLines(term: Terminal, from: number, through: number): LogicalLine[] {
  const buffer = term.buffer.active;
  const lines: LogicalLine[] = [];
  let current: LogicalLine | null = null;
  for (let row = from; row <= through; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    const continued = buffer.getLine(row + 1)?.isWrapped ?? false;
    const text = line.translateToString(!continued);
    if (line.isWrapped && current) {
      current.text += text;
      current.end = row;
    } else {
      current = { text, start: row, end: row };
      lines.push(current);
    }
  }
  return lines;
}

export function findDiagramFences(term: Terminal): DiagramFence[] {
  const buffer = term.buffer.active;
  const viewportTop = buffer.viewportY;
  const lines = logicalLines(
    term,
    Math.max(0, viewportTop - 1000),
    Math.min(buffer.length - 1, viewportTop + term.rows - 1),
  );
  const found: DiagramFence[] = [];
  const occupied = new Set<number>();
  for (let index = 0; index < lines.length; index++) {
    const open = lines[index].text.match(/^\s*(`{3,}|~{3,})\s*(mermaid|d2)\s*$/i);
    if (!open) continue;
    for (let closeIndex = index + 1; closeIndex < lines.length; closeIndex++) {
      const close = lines[closeIndex].text.match(/^\s*(`{3,}|~{3,})\s*$/);
      if (!close || close[1][0] !== open[1][0] || close[1].length < open[1].length) continue;
      found.push({
        language: open[2].toLowerCase() as DiagramLanguage,
        code: lines.slice(index + 1, closeIndex).map((line) => line.text).join("\n"),
        start: lines[index].start,
        end: lines[closeIndex].end,
        inferred: false,
      });
      for (let row = lines[index].start; row <= lines[closeIndex].end; row++) occupied.add(row);
      index = closeIndex;
      break;
    }
  }
  for (let index = 0; index < lines.length; index++) {
    if (occupied.has(lines[index].start)) continue;
    const first = stripTuiBullet(lines[index].text).trimStart();
    const language: DiagramLanguage | null = isMermaidStart(first)
      ? "mermaid"
      : isD2ArrowLine(first) && isD2ArrowLine(stripTuiBullet(lines[index + 1]?.text ?? "").trimStart())
        ? "d2"
        : null;
    if (!language) continue;
    let end = index;
    while (end + 1 < lines.length && stripTuiBullet(lines[end + 1].text).trim()) end++;
    const block = lines.slice(index, end + 1);
    const code = dedent(block.map((line) => stripTuiBullet(line.text)));
    found.push({ language, code, start: block[0].start, end: block[block.length - 1].end, inferred: true });
    index = end;
  }
  return found;
}

function stripTuiBullet(line: string): string {
  return line.replace(/^\s*[•●]\s?/, "");
}

function dedent(lines: string[]): string {
  const indents = lines.filter((line) => line.trim()).map((line) => line.match(/^\s*/)?.[0].length ?? 0);
  const margin = indents.length ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(margin).trimEnd()).join("\n");
}

function isMermaidStart(line: string): boolean {
  return /^(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|quadrantChart|requirementDiagram|C4Context|sankey-beta|xychart-beta)\b/.test(line);
}

function isD2ArrowLine(line: string): boolean {
  return !/-->|<--/.test(line) && /(?:^|\s)(?:<?->|<-)(?:\s|$)/.test(line);
}

function darkBackground(host: HTMLElement): boolean {
  const channels = getComputedStyle(host).backgroundColor.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  return !!channels && channels.reduce((sum, channel) => sum + channel, 0) < 384;
}

async function renderDiagram(fence: DiagramFence, dark: boolean): Promise<string> {
  if (fence.language === "d2") return renderD2(fence.code, dark);
  const mermaid = await loadMermaid();
  mermaid.initialize({
    startOnLoad: false,
    theme: dark ? "dark" : "default",
    flowchart: { htmlLabels: false },
    securityLevel: "strict",
    suppressErrorRendering: true,
  });
  const lines = fence.code.split("\n");
  let lastError: unknown;
  for (let length = lines.length; length > 0; length--) {
    try {
      return (await mermaid.render(`instant-terminal-mermaid-${mermaidId++}`, lines.slice(0, length).join("\n"))).svg;
    } catch (reason) {
      lastError = reason;
      if (!fence.inferred) throw reason;
    }
  }
  throw lastError;
}

function svgAspectRatio(svg: string): number | null {
  const viewBox = svg.match(/\bviewBox=["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*["']/i);
  if (viewBox) {
    const width = Number(viewBox[1]);
    const height = Number(viewBox[2]);
    if (width > 0 && height > 0) return width / height;
  }
  const width = Number(svg.match(/\bwidth=["']([\d.]+)/i)?.[1]);
  const height = Number(svg.match(/\bheight=["']([\d.]+)/i)?.[1]);
  return width > 0 && height > 0 ? width / height : null;
}

export class TerminalDiagramOverlay {
  root: HTMLDivElement;
  disposables: IDisposable[];
  generation = 0;
  frame = 0;
  cache = new Map<string, Promise<string>>();
  lightboxRoot: Root | null = null;
  lightboxMount: HTMLDivElement | null = null;

  constructor(
    readonly term: Terminal,
    readonly host: HTMLElement,
    readonly layout: TerminalDiagramLayout = defaultTerminalDiagramLayout,
  ) {
    this.root = document.createElement("div");
    this.root.className = "term-diagrams";
    host.appendChild(this.root);
    this.disposables = [
      term.onWriteParsed(() => this.schedule()),
      term.onScroll(() => this.schedule()),
      term.onResize(() => this.schedule()),
    ];
    this.schedule();
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      void this.paint();
    });
  }

  async paint() {
    const generation = ++this.generation;
    const screen = this.host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) return;
    const hostRect = this.host.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const cellHeight = screenRect.height / this.term.rows;
    const viewportTop = this.term.buffer.active.viewportY;
    const viewportEnd = viewportTop + this.term.rows - 1;
    const dark = darkBackground(this.host);
    const fences = findDiagramFences(this.term).filter(
      (fence) => fence.end >= viewportTop && fence.start <= viewportEnd,
    );
    const rendered = await Promise.all(fences.map(async (fence) => {
      const key = `${dark}:${fence.language}:${fence.code}`;
      let pending = this.cache.get(key);
      if (!pending) {
        pending = renderDiagram(fence, dark);
        this.cache.set(key, pending);
      }
      try {
        return { fence, svg: await pending, error: "" };
      } catch (reason) {
        this.cache.delete(key);
        return { fence, svg: "", error: reason instanceof Error ? reason.message : `Failed to render ${fence.language}` };
      }
    }));
    if (generation !== this.generation) return;
    this.root.replaceChildren(...rendered.map(({ fence, svg, error }) => {
      const element = document.createElement("div");
      element.className = error ? "term-diagram term-diagram-error" : "term-diagram";
      element.dataset.language = fence.language;
      const aspectRatio = svg ? svgAspectRatio(svg) : null;
      const sourceRows = fence.end - fence.start + 1;
      const requestedHeight = aspectRatio
        ? Math.min(screenRect.height * this.layout.maxViewportHeightRatio, screenRect.width / aspectRatio)
        : sourceRows * cellHeight;
      const requestedRows = Math.max(sourceRows, Math.ceil(requestedHeight / cellHeight));
      let allocatedEnd = fence.end;
      const blankLimit = Math.min(
        this.term.buffer.active.length - 1,
        fence.end + this.layout.maxBlankRows,
        fence.start + requestedRows - 1,
      );
      while (allocatedEnd < blankLimit) {
        const next = this.term.buffer.active.getLine(allocatedEnd + 1);
        if (!next || next.translateToString(true).trim()) break;
        allocatedEnd++;
      }
      element.dataset.sourceRows = String(sourceRows);
      element.dataset.allocatedRows = String(allocatedEnd - fence.start + 1);
      const visibleStart = Math.max(fence.start, viewportTop);
      const visibleEnd = Math.min(allocatedEnd, viewportEnd);
      Object.assign(element.style, {
        left: `${screenRect.left - hostRect.left}px`,
        top: `${screenRect.top - hostRect.top + (visibleStart - viewportTop) * cellHeight}px`,
        width: `${screenRect.width}px`,
        height: `${(visibleEnd - visibleStart + 1) * cellHeight}px`,
      });
      if (error) element.textContent = error;
      else {
        element.title = "Click to expand diagram";
        element.innerHTML = diagramSvgMarkup(svg);
        element.addEventListener("click", () => this.openLarge(svg, fence.language));
      }
      return element;
    }));
  }

  openLarge(svg: string, language: DiagramLanguage) {
    this.closeLarge();
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const root = createRoot(mount);
    const close = () => {
      if (this.lightboxMount === mount) this.closeLarge();
    };
    this.lightboxMount = mount;
    this.lightboxRoot = root;
    root.render(createElement(DiagramLightbox, {
      svg,
      language,
      label: `${language === "d2" ? "d2" : "Mermaid"} diagram`,
      onClose: close,
    }));
  }

  closeLarge() {
    this.lightboxRoot?.unmount();
    this.lightboxMount?.remove();
    this.lightboxRoot = null;
    this.lightboxMount = null;
  }

  dispose() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.generation++;
    this.disposables.forEach((disposable) => disposable.dispose());
    this.closeLarge();
    this.root.remove();
  }
}
