import type { IDisposable, Terminal } from "@xterm/xterm";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { debounceTime, merge, Subject, tap, type Subscription } from "rxjs";
import mermaidBundleUrl from "mermaid/dist/mermaid.min.js?url";
import { DiagramLightbox, diagramSvgMarkup, mermaidTheme, renderD2, type DiagramLightboxEntry } from "@hafley66/md";
import { liveProbe } from "./0_liveProbe";
import type { ProjectedTurnRegion } from "./00_terminalTurnRegions";
import type { TerminalTurnVisibilityV2 } from "./0_terminalTurnVisibility";

export type DiagramLanguage = "mermaid" | "d2";
export type DiagramFence = {
  language: DiagramLanguage;
  code: string;
  start: number;
  end: number;
  inferred: boolean;
  stripped?: boolean;
  locator?: string;
  messageId?: string;
};
type LogicalLine = { text: string; start: number; end: number };
function normalizedDiagramLines(code: string): string[] {
  return code
    .split("\n")
    .map((line) => line.toLowerCase().replace(/^\s*[•●]\s?/, "").replace(/\s+/g, " ").trim())
    .filter((line) => /[a-z0-9]/.test(line) && line.length >= 4);
}
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

function mermaidGlobal(): MermaidApi | undefined {
  return (window as typeof window & { mermaid?: MermaidApi }).mermaid;
}

function failureText(reason: unknown): string {
  if (reason instanceof Error) return `${reason.name}: ${reason.message}`;
  return String(reason);
}

// A script element's error event carries no detail, so the cause is re-read
// from the network. The bundle is fetched from the page origin at first paint,
// long after the page loaded, so a dev server that has since stopped is the
// common answer and only a second request can say so.
async function bundleFailureReason(url: string): Promise<string> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return `HTTP ${response.status} ${response.statusText}`.trim();
    return `served HTTP ${response.status}, so the bundle itself did not execute`;
  } catch (reason) {
    return failureText(reason);
  }
}

function injectMermaidBundle(url: string): Promise<MermaidApi> {
  return new Promise<MermaidApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.addEventListener("load", () => {
      const api = mermaidGlobal();
      if (api) resolve(api);
      else reject(new Error(`Mermaid bundle ${url} ran without defining globalThis.mermaid`));
    });
    script.addEventListener("error", () => {
      void bundleFailureReason(url).then((reason) =>
        reject(new Error(`Mermaid bundle ${url} did not load: ${reason}`)));
    });
    document.head.appendChild(script);
  });
}

export function loadMermaid(): Promise<MermaidApi> {
  const loaded = mermaidGlobal();
  if (loaded) return Promise.resolve(loaded);
  if (mermaidPromise) return mermaidPromise;
  // A rejected load is never kept. The overlay repaints on scroll and on PTY
  // activity, and holding a rejected promise turned one unreachable fetch into
  // a dead diagram for the rest of the app session.
  const attempt = injectMermaidBundle(mermaidBundleUrl).catch((reason) => {
    if (mermaidPromise === attempt) mermaidPromise = null;
    throw reason;
  });
  mermaidPromise = attempt;
  return attempt;
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

// What the terminal overlay treats as a diagram: only ``` fences, also a
// stripped fence whose language label survived as its own row, or also an
// unlabeled body that opens with a diagram keyword.
export const DIAGRAM_INFERENCE = ["explicit", "labels", "inferred"] as const;
export type DiagramInference = (typeof DIAGRAM_INFERENCE)[number];

export function findDiagramFences(term: Terminal, inference: DiagramInference = "inferred"): DiagramFence[] {
  const buffer = term.buffer.active;
  const viewportTop = buffer.viewportY;
  const lines = logicalLines(
    term,
    Math.max(0, viewportTop - 1000),
    Math.min(buffer.length - 1, viewportTop + term.rows + 1000),
  );
  const found: DiagramFence[] = [];
  const occupied = new Set<number>();
  for (let index = 0; index < lines.length; index++) {
    // tmux paints its copy-mode indicator, `[12/340]`, into the right edge of
    // the top row; a fence that lands there still reads as a fence.
    const open = lines[index].text.match(/^\s*(`{3,}|~{3,})\s*(mermaid|d2)\s*(?:\[\d+\/\d+\])?\s*$/i);
    if (!open) continue;
    for (let closeIndex = index + 1; closeIndex < lines.length; closeIndex++) {
      const close = lines[closeIndex].text.match(/^\s*(`{3,}|~{3,})\s*(?:\[\d+\/\d+\])?\s*$/);
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
  if (inference === "explicit") return found;
  // Claude and Codex render Markdown fences without the backticks. The language
  // label survives as its own row, which is enough origin to distinguish a
  // diagram from arrow-shaped source code. Code rows retain Markdown's leading
  // indentation, including across internal blank rows.
  for (let index = 0; index < lines.length; index++) {
    if (occupied.has(lines[index].start)) continue;
    const label = stripTuiBullet(lines[index].text).trim().toLowerCase();
    if (label !== "mermaid" && label !== "d2") continue;
    const firstRaw = stripTuiBullet(lines[index + 1]?.text ?? "");
    const firstCode = firstRaw.trimStart();
    if (label === "mermaid" ? !isMermaidStart(firstCode) : !isD2Start(firstCode)) continue;
    const codeIndent = firstRaw.length - firstCode.length;
    let end = index + 1;
    while (end + 1 < lines.length) {
      const next = stripTuiBullet(lines[end + 1].text);
      const trimmed = next.trim();
      if (!trimmed) {
        // A blank row ends a mermaid block: Claude indents the prose after a
        // stripped fence as deep as its code, so indentation alone let the
        // block run into the next paragraph. A zero-indent block has no other
        // boundary at all. Indented D2 keeps its internal blanks, which
        // separate its declaration groups.
        if (codeIndent === 0 || label === "mermaid") break;
        end++;
        continue;
      }
      if (next.length - next.trimStart().length < codeIndent) break;
      if (endsStrippedBlock(lines[end + 1].text)) break;
      // A fresh language label opens the next diagram rather than continuing this one.
      const nextLabel = trimmed.toLowerCase();
      if (nextLabel === "mermaid" || nextLabel === "d2") break;
      end++;
    }
    const block = lines.slice(index + 1, end + 1);
    found.push({
      language: label,
      code: dedent(block.map((line) => stripTuiBullet(line.text))),
      start: lines[index].start,
      end: lines[end].end,
      inferred: false,
      stripped: true,
    });
    for (let row = lines[index].start; row <= lines[end].end; row++) occupied.add(row);
    index = end;
  }
  if (inference === "labels") return found;
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
    if (language === "d2") {
      while (
        end + 1 < lines.length &&
        isD2ArrowLine(stripTuiBullet(lines[end + 1].text).trimStart())
      ) end++;
    } else {
      const indent = lines[index].text.length - lines[index].text.trimStart().length;
      while (end + 1 < lines.length) {
        const next = lines[end + 1].text;
        if (!next.trim() || endsStrippedBlock(next)) break;
        if (next.length - next.trimStart().length < indent) break;
        end++;
      }
    }
    const block = lines.slice(index, end + 1);
    const code = dedent(block.map((line) => stripTuiBullet(line.text)));
    found.push({ language, code, start: block[0].start, end: block[block.length - 1].end, inferred: true });
    index = end;
  }
  return found;
}

export function mergeLocatedDiagrams(direct: DiagramFence[], ledger: DiagramFence[]): DiagramFence[] {
  const fences = [...direct];
  for (const candidate of ledger) {
    const overlapIndex = fences.findIndex((fence) =>
      fence.language === candidate.language &&
      fence.start <= candidate.end &&
      candidate.start <= fence.end
    );
    if (overlapIndex < 0) {
      fences.push(candidate);
      continue;
    }
    const visibleLines = normalizedDiagramLines(fences[overlapIndex].code);
    const ledgerLines = normalizedDiagramLines(candidate.code);
    const visibleIsClippedPrefix = visibleLines.length < ledgerLines.length
      && visibleLines.every((line, index) => line === ledgerLines[index]);
    if (visibleIsClippedPrefix) fences[overlapIndex] = candidate;
  }
  return fences;
}

export function projectedDiagramIsCurrent(
  term: Pick<Terminal, "buffer">,
  region: ProjectedTurnRegion,
): boolean {
  const sourceLines = region.text.split("\n");
  const matchedRows = region.sourceBufferRows?.slice(1, -1) ?? [];
  let currentMatches = 0;
  let comparableRows = 0;
  for (let index = 0; index < matchedRows.length; index++) {
    const row = matchedRows[index];
    if (row === null || row === undefined) continue;
    const source = normalizedDiagramLines(sourceLines[index] ?? "")[0];
    const visible = normalizedDiagramLines(term.buffer.active.getLine(row)?.translateToString(true) ?? "")[0];
    if (!source || !visible) continue;
    comparableRows++;
    if (source === visible || source.includes(visible) || visible.includes(source)) currentMatches++;
  }
  return comparableRows > 0 && currentMatches >= Math.min(2, comparableRows);
}

export function diagramElementKey(fence: DiagramFence, dark: boolean): string {
  // The physical buffer row is positioning data, not identity. A rescan that
  // re-anchors the same logical diagram one row must keep its DOM element, so
  // the key codes the stable turn-scoped locator when present and falls back to
  // a code fingerprint for terminal-only explicit fences that carry no locator.
  const stable = fence.locator ?? `${fence.language}:${normalizedDiagramLines(fence.code).join("\n")}`;
  return `${dark}:${stable}`;
}

function stripTuiBullet(line: string): string {
  return line.replace(/^\s*[•●]\s?/, "");
}

// A fence without backticks has no closer, so the rows a TUI paints after the
// diagram bound it: a box-drawn table or frame (U+2500-U+257F), a bullet (the
// next message's `●`, a list item), or a prompt/composer row.
function endsStrippedBlock(line: string): boolean {
  const text = line.trimStart();
  const first = text.codePointAt(0) ?? 0;
  if (first >= 0x2500 && first <= 0x257f) return true;
  return /^(?:[•●]|[-*>❯›$]\s)/.test(text);
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
  if (/\/\/|[;{}]|-->|<--/.test(line)) return false;
  const atom = String.raw`(?:"[^"\n]+"|[A-Za-z_][\w.-]*)`;
  const arrow = String.raw`(?:<?->|<-)`;
  return new RegExp(String.raw`^\s*${atom}(?:\s+${arrow}\s+${atom})+(?:\s*:\s*.+)?\s*$`).test(line);
}

function isD2Start(line: string): boolean {
  return /^(?:direction|classes|vars)\s*:/.test(line) || isD2ArrowLine(line);
}

function darkBackground(host: HTMLElement): boolean {
  const channels = getComputedStyle(host).backgroundColor.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  return !!channels && channels.reduce((sum, channel) => sum + channel, 0) < 384;
}

type RenderedDiagram = { svg: string; code: string; lineCount: number };
const MAX_TAIL_RECOVERY_ATTEMPTS = 16;
const MAX_RENDER_CACHE_ENTRIES = 32;
const MAX_LIGHTBOX_ENTRIES = 32;

export async function renderDiagram(fence: DiagramFence, dark: boolean): Promise<RenderedDiagram> {
  if (fence.language === "d2") {
    const lines = fence.code.split("\n");
    let lastError: unknown;
    const minimum = Math.max(1, lines.length - MAX_TAIL_RECOVERY_ATTEMPTS + 1);
    for (let length = lines.length; length >= minimum; length--) {
      try {
        const code = lines.slice(0, length).join("\n");
        const rendered = await renderD2(code, dark);
        if (typeof rendered !== "string") throw new Error("D2 renderer returned no SVG markup");
        liveProbe.record({ kind: "operation", name: "terminal.renderD2", detail: { dark, sourceBytes: code.length, svgBytes: rendered.length } });
        return { svg: rendered, code, lineCount: length };
      } catch (reason) {
        lastError = reason;
        if (!fence.stripped) throw reason;
      }
    }
    throw lastError;
  }
  const mermaid = await loadMermaid();
  mermaid.initialize({
    startOnLoad: false,
    ...mermaidTheme(dark),
    // Top-level htmlLabels is the only switch mermaid 11 honours; the per-diagram
    // flowchart.htmlLabels alone still emits foreignObject, which WebKit rasterises
    // once and cannot resharpen when the lightbox rewrites the viewBox to zoom.
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    securityLevel: "strict",
    suppressErrorRendering: true,
    maxEdges: 2_000,
  });
  const lines = fence.code.split("\n");
  let lastError: unknown;
  const minimum = Math.max(lines.length === 1 ? 1 : 2, lines.length - MAX_TAIL_RECOVERY_ATTEMPTS + 1);
  for (let length = lines.length; length >= minimum; length--) {
    const code = lines.slice(0, length).join("\n");
    try {
      const rendered = await mermaid.render(`instant-terminal-mermaid-${mermaidId++}`, code);
      if (typeof rendered?.svg !== "string") throw new Error("Mermaid renderer returned no SVG markup");
      liveProbe.record({ kind: "operation", name: "terminal.renderMermaid", detail: { dark, sourceBytes: code.length, svgBytes: rendered.svg.length } });
      return { svg: rendered.svg, code, lineCount: length };
    } catch (reason) {
      lastError = reason;
      if (!fence.inferred && !fence.stripped) throw reason;
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

export function diagramElementAtPoint(
  elements: HTMLElement[],
  clientX: number | null,
  clientY: number,
): HTMLElement | null {
  return elements.slice().reverse().find((element) => {
    if (element.hidden) return false;
    const rect = element.getBoundingClientRect();
    return (clientX === null || (rect.left <= clientX && clientX <= rect.right))
      && rect.top <= clientY
      && clientY <= rect.bottom;
  }) ?? null;
}

export class TerminalDiagramOverlay {
  root: HTMLDivElement;
  disposables: IDisposable[];
  generation = 0;
  frame = 0;
  painting = false;
  repaintPending = false;
  activitySubscription: Subscription | null = null;
  scrollEvents = new Subject<void>();
  scrollSubscription: Subscription;
  recoveryEvents = new Subject<void>();
  recoverySubscription: Subscription;
  scrolling = false;
  lastScrollAt = Number.NEGATIVE_INFINITY;
  cache = new Map<string, Promise<RenderedDiagram>>();
  elementCache = new Map<string, HTMLElement>();
  lightboxRoot: Root | null = null;
  lightboxMount: HTMLDivElement | null = null;
  lightboxEntries: DiagramLightboxEntry[] = [];
  lightboxActive = 0;
  lightboxSequence = 0;
  hideRequested = false;
  lastPaintedFingerprint = "";
  // Plan keys of the fences the last paint drew; a scan holds these on screen.
  paintedKeys = new Set<string>();
  // Stripped fences on the buffer when the last scan settled. The ledger had its
  // chance to claim them, so a later scan no longer holds them back.
  settledKeys = new Set<string>();
  retryTimer: ReturnType<typeof setTimeout> | null = null;
  retryDelayMs = 2_000;

  constructor(
    readonly term: Terminal,
    readonly host: HTMLElement,
    readonly layout: TerminalDiagramLayout = defaultTerminalDiagramLayout,
    readonly projection?: Pick<TerminalTurnVisibilityV2, "visible" | "changes" | "settled" | "scanning">,
    readonly enabled: () => boolean = () => true,
    public inference: () => DiagramInference = () => "labels",
  ) {
    this.root = document.createElement("div");
    this.root.className = "term-diagrams";
    host.appendChild(this.root);
    // renderPlan() holds stripped fences back while a scan runs, so the scan's
    // end repaints even when it emitted no visibility change. The repaint can
    // queue behind a paint still rendering and run after the next scan starts,
    // so the settle itself admits the stripped fences it saw.
    if (projection) this.activitySubscription = merge(
      projection.changes,
      projection.settled.pipe(tap(() => {
        const dark = darkBackground(this.host);
        this.settledKeys = new Set(findDiagramFences(this.term, this.inference())
          .filter((fence) => fence.stripped)
          .map((fence) => diagramElementKey(fence, dark)));
      })),
    ).subscribe(() => this.scheduleFrame());
    this.scrollSubscription = this.scrollEvents.pipe(
      debounceTime(80),
    ).subscribe(() => {
      this.scrolling = false;
      this.applyPendingHide();
      this.positionElements();
      this.scheduleFrame();
    });
    this.recoverySubscription = this.recoveryEvents.pipe(
      debounceTime(80),
    ).subscribe(() => {
      this.applyPendingHide();
      this.scheduleFrame();
    });
    const onClick = (event: MouseEvent) => {
      // ⌘-click routes the label as a token (clickrules.ts); plain click zooms.
      if (event.metaKey) return;
      if (event.button !== 0 || !this.openAtClientPoint(event.clientX, event.clientY)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    host.addEventListener("click", onClick, { capture: true });
    this.disposables = [
      { dispose: () => host.removeEventListener("click", onClick, { capture: true }) },
      term.onWriteParsed(() => {
        if (this.projection) {
          // The gate covers the merged fence set, so a pane the turn ledger
          // cannot see still paints the fences its own buffer carries.
          if (this.renderPlan().fingerprint === this.lastPaintedFingerprint) return;
          this.hideRequested = true;
          this.generation++;
          this.positionElements();
          if (!this.scrolling) this.recoveryEvents.next();
        }
        else this.scheduleFrame();
      }),
      // PTY output advancing the viewport also fires onScroll. Keep existing
      // diagrams attached to their rows during that automatic movement; the
      // wheel router calls viewportScrolled() explicitly for user scrolling,
      // where hiding until the new row positions settle is still required.
      term.onScroll(() => {
        this.positionElements();
        if (!this.scrolling) this.scheduleFrame();
      }),
      term.onResize(() => {
        this.positionElements();
        this.scheduleFrame();
      }),
    ];
    this.scheduleFrame();
  }

  viewportScrolled() {
    if (this.projection) {
      // A routed wheel gesture repaints the pane from tmux (copy-mode
      // included), so the overlay ducks; the debounced scroll paint reveals.
      this.scrolling = true;
      this.lastScrollAt = performance.now();
      this.root.hidden = true;
      this.hideRequested = false;
      this.generation++;
      this.positionElements();
      this.scrollEvents.next();
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

  syncEnabled() {
    if (!this.enabled()) {
      this.generation++;
      this.root.hidden = true;
      return;
    }
    this.activate();
  }

  scheduleFrame() {
    if (!this.enabled()) {
      this.root.hidden = true;
      return;
    }
    if (this.painting) {
      this.repaintPending = true;
      return;
    }
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.painting = true;
      void this.paint().finally(() => {
        this.painting = false;
        if (!this.repaintPending) return;
        this.repaintPending = false;
        this.scheduleFrame();
      });
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

  applyPendingHide() {
    if (!this.hideRequested) return;
    this.root.hidden = true;
    this.hideRequested = false;
  }

  fenceFor(region: ProjectedTurnRegion & { kind: "mermaid" | "d2" }): DiagramFence {
    return {
      language: region.kind,
      code: region.text,
      start: region.bufferStart,
      end: region.bufferEnd,
      inferred: false,
      locator: `boop:${region.turnId}`,
      messageId: region.turnId,
    };
  }

  // One buffer+projection pass shared by the write/scroll gates and paint(), so
  // both answer "what would a repaint render?" identically.
  renderPlan() {
    const viewportTop = this.term.buffer.active.viewportY;
    const viewportEnd = viewportTop + this.term.rows - 1;
    const dark = darkBackground(this.host);
    const projected = this.projection?.visible.flatMap((turn) => turn.regions
      .filter((region): region is ProjectedTurnRegion & { kind: "mermaid" | "d2" } =>
        (region.kind === "mermaid" || region.kind === "d2") && projectedDiagramIsCurrent(this.term, region))
      .map((region) => this.fenceFor(region))) ?? [];
    // The opencode TUI strips a fenced code block's backticks and its language
    // label, leaving an indented `timeline`/`flowchart` body with no origin row.
    // That shape is content-inferred, so it paints from the pane only where the
    // turn ledger cannot supply the same block: an unbound pane, or a projection
    // whose source rows no longer match. A current ledger region wins, keeping
    // its turn locator. D2 arrow inference stays excluded; only a mermaid start
    // keyword is specific enough to read as a diagram without a fence.
    // A scan holds back a stripped fence that is not yet on screen, so a ledger
    // region can claim it first; one already drawn stays drawn, or every scan
    // during PTY activity would erase it until the scan settled.
    const direct = findDiagramFences(this.term, this.inference()).filter((fence) => {
      if (fence.stripped && this.projection?.scanning) {
        const key = diagramElementKey(fence, dark);
        return this.paintedKeys.has(key) || this.settledKeys.has(key);
      }
      if (!fence.inferred) return true;
      if (fence.language !== "mermaid") return false;
      return !projected.some((region) =>
        region.language === fence.language && region.start <= fence.end && fence.start <= region.end);
    });
    // Explicit terminal fences stay available while the ledger is empty or
    // unable to locate its source; mergeLocatedDiagrams arbitrates overlap.
    const visibleFences = mergeLocatedDiagrams(direct, projected).filter(
      (fence) => fence.end >= viewportTop && fence.start <= viewportEnd,
    );
    // Covers the merged set, code length, and theme, so direct fences and
    // streaming growth still repaint; skipping never advances generation.
    const fingerprint = `${dark}:${viewportTop}:${visibleFences
      .map((fence) => `${diagramElementKey(fence, dark)}#${fence.code.length}`)
      .sort()
      .join("|")}`;
    return { dark, viewportTop, viewportEnd, visibleFences, fingerprint };
  }

  // A paint whose renders failed must recover on its own: backoff caps at 30s
  // and a successful paint resets the delay.
  scheduleRetry() {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.scheduleFrame();
    }, this.retryDelayMs);
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, 30_000);
  }

  clearRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryDelayMs = 2_000;
  }

  async paint() {
    if (!this.enabled()) {
      this.root.hidden = true;
      return;
    }
    if (this.scrolling) {
      // Wheel ticks hold the root hidden; the 80ms scroll-quiet window owns
      // the one reveal paint, so nothing repaints mid-gesture.
      this.root.hidden = true;
      return;
    }
    const screen = this.host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) return;
    const screenRect = screen.getBoundingClientRect();
    const cellHeight = screenRect.height / this.term.rows;
    const { dark, visibleFences, fingerprint } = this.renderPlan();
    // A matching fingerprint skips the render only while the result is on
    // screen; activate() and syncEnabled() hide the root to force a repaint.
    if (fingerprint === this.lastPaintedFingerprint && !this.root.hidden) return;
    const generation = ++this.generation;
    const rendered = await Promise.all(visibleFences.map(async (fence) => {
      const key = `${dark}:${fence.language}:${fence.code}`;
      let pending = this.cache.get(key);
      if (!pending) {
        pending = renderDiagram(fence, dark);
        this.cache.set(key, pending);
        if (this.cache.size > MAX_RENDER_CACHE_ENTRIES) {
          const oldest = this.cache.keys().next().value;
          if (oldest !== undefined) this.cache.delete(oldest);
        }
      }
      try {
        const result = await pending;
        const renderedFence = result.lineCount < fence.code.split("\n").length
          ? {
              ...fence,
              code: result.code,
              end: Math.min(fence.end, fence.start + result.lineCount),
            }
          : fence;
        return { fence: renderedFence, svg: result.svg, error: "" };
      } catch (reason) {
        if (this.cache.get(key) === pending) this.cache.delete(key);
        return { fence, svg: "", error: reason instanceof Error ? reason.message : `Failed to render ${fence.language}` };
      }
    }));
    if (generation !== this.generation) return;
    this.paintedKeys = new Set(visibleFences
      .filter((_, index) => !rendered[index].error)
      .map((fence) => diagramElementKey(fence, dark)));
    // A content-inferred block that fails to parse is prose that happened to
    // open with a diagram keyword, so it drops silently rather than pinning an
    // error box on the pane. Only an explicit or ledger-backed failure retries.
    // Any other failure paints nothing over the rows either: the raw source
    // stays readable in the terminal, and an error panel would cover it.
    const drawable = rendered.filter((entry) => !entry.error);
    // An errored render stays unpinned so idle rescans and the retry timer
    // keep attempting it; a success pins and resets the backoff.
    const failures = rendered.filter((entry) => entry.error && !entry.fence.inferred).map((entry) => entry.error);
    // The reason stays inspectable on the root without drawing over the pane.
    if (failures.length) this.root.dataset.diagramError = failures.join("\n");
    else delete this.root.dataset.diagramError;
    if (failures.length) this.scheduleRetry();
    else {
      this.lastPaintedFingerprint = fingerprint;
      this.clearRetry();
    }
    this.root.hidden = false;
    const existing = new Map(Array.from(this.root.querySelectorAll<HTMLElement>(".term-diagram"))
      .map((element) => [element.dataset.diagramKey ?? "", element]));
    // Duplicate fences (same locator or same direct code) collapsed onto one
    // element after the locator re-key; the occurrence suffix fixes that.
    const occurrences = new Map<string, number>();
    const elements = drawable.map(({ fence, svg }) => {
      const base = diagramElementKey(fence, dark);
      const seen = occurrences.get(base) ?? 0;
      occurrences.set(base, seen + 1);
      const diagramKey = seen === 0 ? base : `${base}#${seen}`;
      const element = existing.get(diagramKey) ?? this.elementCache.get(diagramKey) ?? document.createElement("div");
      const created = !element.dataset.diagramKey;
      this.elementCache.set(diagramKey, element);
      element.dataset.diagramKey = diagramKey;
      element.dataset.language = fence.language;
      element.dataset.diagramTheme = dark ? "dark" : "light";
      element.dataset.diagramCode = fence.code;
      element.dataset.diagramLocator = fence.locator ?? "terminal buffer";
      element.dataset.diagramInferred = String(fence.inferred);
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
      if (created) {
        element.className = "term-diagram";
        element.title = "Click to expand diagram";
        element.innerHTML = diagramSvgMarkup(svg);
      }
      return element;
    });
    const current = Array.from(this.root.children);
    if (current.length !== elements.length || elements.some((element, index) => current[index] !== element)) {
      this.root.replaceChildren(...elements);
    }
    this.positionElements(screen);
  }

  openLarge(entry: DiagramLightboxEntry) {
    this.closeLarge();
    this.lightboxEntries.push(entry);
    if (this.lightboxEntries.length > MAX_LIGHTBOX_ENTRIES) this.lightboxEntries.shift();
    this.lightboxActive = this.lightboxEntries.length - 1;
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const root = createRoot(mount);
    const close = () => {
      if (this.lightboxMount === mount) this.closeLarge();
    };
    this.lightboxMount = mount;
    this.lightboxRoot = root;
    const render = () => root.render(createElement(DiagramLightbox, {
      entries: this.lightboxEntries,
      activeIndex: this.lightboxActive,
      label: `${entry.language === "d2" ? "d2" : "Mermaid"} diagram`,
      onSelect: (index: number) => {
        this.lightboxActive = index;
        render();
      },
      onClose: close,
    }));
    render();
  }

  diagramAtClientPoint(clientX: number | null, clientY: number): DiagramLightboxEntry | null {
    const target = diagramElementAtPoint(
      Array.from(this.root.querySelectorAll<HTMLElement>(".term-diagram")),
      clientX,
      clientY,
    );
    if (!target) return null;
    return {
      id: `${target.dataset.diagramKey}:${this.lightboxSequence++}`,
      svg: target.innerHTML,
      language: target.dataset.language as DiagramLanguage,
      dark: target.dataset.diagramTheme === "dark",
      code: target.dataset.diagramCode ?? "",
      locator: target.dataset.diagramLocator ?? "terminal buffer",
      bufferStart: Number(target.dataset.bufferStart),
      bufferEnd: Number(target.dataset.bufferEnd),
      inferred: false,
    };
  }

  openAtClientY(clientY: number): boolean {
    const entry = this.diagramAtClientPoint(null, clientY);
    if (!entry) return false;
    this.openLarge(entry);
    return true;
  }

  openAtClientPoint(clientX: number, clientY: number): boolean {
    const entry = this.diagramAtClientPoint(clientX, clientY);
    if (!entry) return false;
    this.openLarge(entry);
    return true;
  }

  closeLarge() {
    this.lightboxRoot?.unmount();
    this.lightboxMount?.remove();
    this.lightboxRoot = null;
    this.lightboxMount = null;
  }

  dispose() {
    this.clearRetry();
    if (this.frame) cancelAnimationFrame(this.frame);
    this.activitySubscription?.unsubscribe();
    this.scrollSubscription.unsubscribe();
    this.scrollEvents.complete();
    this.recoverySubscription.unsubscribe();
    this.recoveryEvents.complete();
    this.generation++;
    this.disposables.forEach((disposable) => disposable.dispose());
    this.cache.clear();
    this.elementCache.clear();
    this.lightboxEntries.length = 0;
    this.closeLarge();
    this.root.remove();
  }
}
