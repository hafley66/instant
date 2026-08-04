import type { IDisposable, Terminal } from "@xterm/xterm";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { debounceTime, Subject, type Subscription } from "rxjs";
import mermaidBundleUrl from "mermaid/dist/mermaid.min.js?url";
import { DiagramLightbox, diagramSvgMarkup } from "./mdview/0_DiagramLightbox";
import { renderD2 } from "./mdview/d2";
import { diagramsFromMessageTail, normalizedDiagramLines, type MessageDiagram } from "./0_terminalDiagramMessages";
import type { AiMessage } from "./state";

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

function normalizeTerminalLine(line: string): string {
  return stripTuiBullet(line).toLowerCase().replace(/\s+/g, " ").trim();
}

export function locateMessageDiagrams(term: Terminal, diagrams: MessageDiagram[]): DiagramFence[] {
  const buffer = term.buffer.active;
  const viewportTop = buffer.viewportY;
  const viewportEnd = Math.min(buffer.length - 1, viewportTop + term.rows - 1);
  const lines = logicalLines(term, viewportTop, viewportEnd);
  const normalized = lines.map((line) => normalizeTerminalLine(line.text));
  const found: DiagramFence[] = [];
  for (const diagram of diagrams) {
    const sourceLines = normalizedDiagramLines(diagram.code);
    const anchors = sourceLines
      .map((text, sourceIndex) => ({ text, sourceIndex }))
      .sort((a, b) => b.text.length - a.text.length);
    let hit: { terminalIndex: number; sourceIndex: number } | null = null;
    for (const anchor of anchors) {
      const terminalIndex = normalized.findIndex((line) => line === anchor.text || line.includes(anchor.text));
      if (terminalIndex >= 0) {
        hit = { terminalIndex, sourceIndex: anchor.sourceIndex };
        break;
      }
    }
    if (!hit) continue;
    const estimatedStart = lines[hit.terminalIndex].start - hit.sourceIndex;
    const start = Math.max(viewportTop, estimatedStart);
    const end = Math.min(viewportEnd, estimatedStart + Math.max(0, sourceLines.length - 1));
    found.push({
      language: diagram.language,
      code: diagram.code,
      start,
      end: Math.max(start, end),
      inferred: false,
    });
  }
  return found;
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
  if (fence.language === "d2") {
    const rendered = await renderD2(fence.code, dark);
    if (typeof rendered !== "string") throw new Error("D2 renderer returned no SVG markup");
    return rendered;
  }
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
      const rendered = await mermaid.render(`instant-terminal-mermaid-${mermaidId++}`, lines.slice(0, length).join("\n"));
      if (typeof rendered?.svg !== "string") throw new Error("Mermaid renderer returned no SVG markup");
      return rendered.svg;
    } catch (reason) {
      lastError = reason;
      if (!fence.inferred) throw reason;
    }
  }
  throw lastError;
}

export function svgAspectRatio(svg: unknown): number | null {
  if (typeof svg !== "string") return null;
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
  activityEvents = new Subject<void>();
  activitySubscription: Subscription | null = null;
  scrollEvents = new Subject<void>();
  scrollSubscription: Subscription;
  cache = new Map<string, Promise<string>>();
  lightboxRoot: Root | null = null;
  lightboxMount: HTMLDivElement | null = null;

  constructor(
    readonly term: Terminal,
    readonly host: HTMLElement,
    readonly layout: TerminalDiagramLayout = defaultTerminalDiagramLayout,
    readonly messages?: () => Promise<AiMessage[] | null>,
  ) {
    this.root = document.createElement("div");
    this.root.className = "term-diagrams";
    host.appendChild(this.root);
    if (messages) {
      this.activitySubscription = this.activityEvents.pipe(
        debounceTime(1000),
      ).subscribe(() => this.scheduleFrame());
    }
    this.scrollSubscription = this.scrollEvents.pipe(
      debounceTime(120),
    ).subscribe(() => this.scheduleFrame());
    const onWheel = (event: WheelEvent) => {
      this.viewportScrolled();
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest(".term-diagram")) return;
      host.querySelector<HTMLElement>(".xterm")?.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: event.clientX,
        clientY: event.clientY,
        deltaMode: event.deltaMode,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaZ: event.deltaZ,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
      }));
    };
    host.addEventListener("wheel", onWheel, { capture: true, passive: true });
    this.disposables = [
      { dispose: () => host.removeEventListener("wheel", onWheel, { capture: true }) },
      term.onWriteParsed(() => {
        if (this.messages) {
          this.positionElements();
          this.activityEvents.next();
        }
        else this.scheduleFrame();
      }),
      term.onScroll(() => this.viewportScrolled()),
      term.onResize(() => {
        this.positionElements();
        this.scheduleFrame();
      }),
    ];
    this.scheduleFrame();
  }

  viewportScrolled() {
    if (this.messages) {
      this.positionElements();
      this.root.hidden = true;
      this.scrollEvents.next();
      this.activityEvents.next();
    } else {
      this.scheduleFrame();
    }
  }

  activate() {
    this.root.hidden = true;
    this.generation++;
    this.positionElements();
    this.scheduleFrame();
  }

  scheduleFrame() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      void this.paint();
    });
  }

  positionElements(screen = this.host.querySelector<HTMLElement>(".xterm-screen")) {
    if (!screen) return;
    const hostRect = this.host.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const cellHeight = screenRect.height / this.term.rows;
    const viewportTop = this.term.buffer.active.viewportY;
    const viewportEnd = viewportTop + this.term.rows - 1;
    this.root.querySelectorAll<HTMLElement>(".term-diagram").forEach((element) => {
      const start = Number(element.dataset.bufferStart);
      const end = Number(element.dataset.bufferEnd);
      const visibleStart = Math.max(start, viewportTop);
      const visibleEnd = Math.min(end, viewportEnd);
      element.hidden = visibleStart > visibleEnd;
      if (element.hidden) return;
      Object.assign(element.style, {
        left: `${screenRect.left - hostRect.left}px`,
        top: `${screenRect.top - hostRect.top + (visibleStart - viewportTop) * cellHeight}px`,
        width: `${screenRect.width}px`,
        height: `${(visibleEnd - visibleStart + 1) * cellHeight}px`,
      });
    });
  }

  async paint() {
    const generation = ++this.generation;
    const screen = this.host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) return;
    const screenRect = screen.getBoundingClientRect();
    const cellHeight = screenRect.height / this.term.rows;
    const viewportTop = this.term.buffer.active.viewportY;
    const viewportEnd = viewportTop + this.term.rows - 1;
    const dark = darkBackground(this.host);
    const messages = await this.messages?.();
    if (generation !== this.generation) return;
    const fences = (messages
      ? locateMessageDiagrams(this.term, diagramsFromMessageTail(messages))
      : findDiagramFences(this.term)).filter(
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
    this.root.hidden = false;
    const existing = new Map(Array.from(this.root.querySelectorAll<HTMLElement>(".term-diagram"))
      .map((element) => [element.dataset.diagramKey ?? "", element]));
    const elements = rendered.map(({ fence, svg, error }) => {
      const diagramKey = `${dark}:${fence.language}:${fence.code}`;
      const element = existing.get(diagramKey) ?? document.createElement("div");
      const created = !element.dataset.diagramKey;
      element.dataset.diagramKey = diagramKey;
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
      element.dataset.bufferStart = String(fence.start);
      element.dataset.bufferEnd = String(allocatedEnd);
      if (error && (created || !element.classList.contains("term-diagram-error"))) {
        element.className = "term-diagram term-diagram-error";
        element.textContent = error;
      } else if (!error && (created || element.classList.contains("term-diagram-error"))) {
        element.className = "term-diagram";
        element.title = "Click to expand diagram";
        element.innerHTML = diagramSvgMarkup(svg);
        element.addEventListener("click", () => this.openLarge(svg, fence.language));
      }
      return element;
    });
    const current = Array.from(this.root.children);
    if (current.length !== elements.length || elements.some((element, index) => current[index] !== element)) {
      this.root.replaceChildren(...elements);
    }
    this.positionElements(screen);
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
    this.activitySubscription?.unsubscribe();
    this.activityEvents.complete();
    this.scrollSubscription.unsubscribe();
    this.scrollEvents.complete();
    this.generation++;
    this.disposables.forEach((disposable) => disposable.dispose());
    this.closeLarge();
    this.root.remove();
  }
}
