import type { IDisposable, Terminal } from "@xterm/xterm";
import type { Subscription } from "rxjs";
import type { ProjectedTurnRegion } from "./00_terminalTurnRegions";
import type { TerminalTurnVisibilityV2 } from "./0_terminalTurnVisibility";

type StructuredRegion = ProjectedTurnRegion & { kind: "table" | "list" };

function cells(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}

export function structuredRegionMarkup(region: StructuredRegion): string {
  if (region.kind === "table") {
    const lines = region.text.split("\n");
    const headings = cells(lines[0]);
    const body = lines.slice(2).map(cells);
    return `<table><thead><tr>${headings.map((value) => `<th>${escape(value)}</th>`).join("")}</tr></thead>`
      + `<tbody>${body.map((row) => `<tr>${row.map((value) => `<td>${escape(value)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  }
  const items = region.text.split("\n").filter((line) => /^\s*(?:[-+*]|\d+[.)])\s+/.test(line));
  return `<ul>${items.map((line) => `<li>${escape(line.replace(/^\s*(?:[-+*]|\d+[.)])\s+/, ""))}</li>`).join("")}</ul>`;
}

function escape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export class TerminalStructuredOverlay {
  root = document.createElement("div");
  elements = new Map<string, HTMLElement>();
  subscription: Subscription;
  disposables: IDisposable[];
  modal: HTMLElement | null = null;

  constructor(
    readonly term: Terminal,
    readonly host: HTMLElement,
    readonly projection: Pick<TerminalTurnVisibilityV2, "visible" | "changes">,
  ) {
    this.root.className = "term-structured-overlays";
    host.appendChild(this.root);
    this.subscription = projection.changes.subscribe(() => this.paint());
    this.disposables = [
      term.onScroll(() => this.paint()),
      term.onResize(() => this.paint()),
      term.onWriteParsed(() => this.paint()),
    ];
    this.paint();
  }

  regions(): StructuredRegion[] {
    return this.projection.visible.flatMap((turn) => turn.regions.filter(
      (region): region is StructuredRegion => region.kind === "table" || region.kind === "list",
    ));
  }

  paint() {
    const screen = this.host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) return;
    const hostRect = this.host.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const rowHeight = screenRect.height / this.term.rows;
    const top = this.term.buffer.active.viewportY;
    const bottom = top + this.term.rows - 1;
    const live = new Set<string>();
    for (const region of this.regions()) {
      if (region.bufferEnd < top || region.bufferStart > bottom) continue;
      live.add(region.id);
      let element = this.elements.get(region.id);
      if (!element) {
        element = document.createElement("button");
        element.className = "term-structured-overlay";
        element.tabIndex = -1;
        element.dataset.regionId = region.id;
        element.addEventListener("mousedown", () => this.term.focus());
        element.addEventListener("click", () => this.open(region));
        this.elements.set(region.id, element);
        this.root.appendChild(element);
      }
      element.textContent = `${region.kind === "table" ? "▦ TABLE" : "☷ LIST"} · click to expand`;
      const visibleStart = Math.max(top, region.bufferStart);
      const visibleEnd = Math.min(bottom, region.bufferEnd);
      Object.assign(element.style, {
        left: `${screenRect.left - hostRect.left}px`,
        top: `${screenRect.top - hostRect.top + (visibleStart - top) * rowHeight}px`,
        width: `${Math.min(190, screenRect.width)}px`,
        height: `${Math.min(rowHeight * 1.5, (visibleEnd - visibleStart + 1) * rowHeight)}px`,
      });
    }
    for (const [id, element] of this.elements) if (!live.has(id)) {
      element.remove();
      this.elements.delete(id);
    }
  }

  open(region: StructuredRegion) {
    this.close();
    const modal = document.createElement("div");
    modal.className = "term-structured-modal";
    modal.dataset.kind = region.kind;
    modal.innerHTML = `<section><header>${region.kind.toUpperCase()} · ${region.turnId}<button aria-label="Close">×</button></header>${structuredRegionMarkup(region)}</section>`;
    modal.querySelector("button")?.addEventListener("click", () => this.close());
    modal.addEventListener("click", (event) => { if (event.target === modal) this.close(); });
    document.body.appendChild(modal);
    this.modal = modal;
  }

  close() {
    this.modal?.remove();
    this.modal = null;
  }

  dispose() {
    this.subscription.unsubscribe();
    this.disposables.forEach((disposable) => disposable.dispose());
    this.close();
    this.root.remove();
  }
}
