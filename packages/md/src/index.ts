// The mdview plugin: markdown viewer dock panels (`md:<path>`) plus the
// Config-panel toggle for the fold default. Routing callers (preview.ts,
// clickrules.ts) use openMarkdownPanel from ./open — re-exported here for
// convenience.
import { createElement, useCallback, useEffect } from "react";
import type { IDockviewPanelProps } from "dockview";
import { getMdviewHost } from "./ports";
import { baseName, MD_EXTS } from "./local/core";
import { MdPanel } from "./MdPanel";
import { loadPersistedMdUi, mdUi, pathSignalFor, setMdUi } from "./signals";
import { registerMdNav, openMarkdownPanel } from "./open";

export { openMarkdownPanel } from "./open";
export { installMdviewHost, getMdviewHost } from "./ports";
export type { MdviewHost } from "./ports";
export { DiagramLightbox, diagramSvgMarkup } from "./0_DiagramLightbox";
export type { DiagramLightboxEntry } from "./0_DiagramLightbox";
export { d2ThemeId, diagramPalette, mermaidTheme } from "./0_diagramTheme";
export { preloadD2, renderD2 } from "./d2";
export { decorateSequenceSvg, isSequenceDiagramSource, parseSequenceSource, sequenceFocusFromElement, sequenceMarkup } from "./1_sequence";
export type { SequenceActivation, SequenceActor, SequenceGroup, SequenceMessage, SequenceModel } from "./1_sequence";
export { parseMdSections } from "./model";

function MdInstance(props: IDockviewPanelProps) {
  const pid = String(props.params.panelId ?? "");
  const initial = String(props.params.path ?? "");
  const sig = pathSignalFor(pid, initial);
  // The one navigate path for explorer clicks, in-doc links, and external
  // re-opens: swap the document signal and retitle the tab.
  const navigate = useCallback(
    (p: string) => {
      sig.$(p);
      props.api.setTitle(baseName(p));
      // Keep params in step with the signal so a reload restores the doc the
      // user navigated to, not the one the tab was opened with.
      props.api.updateParameters({ panelId: pid, path: p });
    },
    [pid, props.api, sig],
  );
  useEffect(() => registerMdNav(pid, navigate), [pid, navigate]);
  return createElement(MdPanel, { pid, pathSig: sig, onNavigate: navigate });
}

export function registerMdview() {
  const host = getMdviewHost();
  loadPersistedMdUi(); // seed mdUi from persisted state now that a host exists
  host.registerPlugin({
    id: "md",
    panels: [], // no rail button: panels are per-file, opened via routing
    options: [
      {
        id: "mdStartFolded",
        label: "Markdown: open folded (outline first)",
        hint: "docs open with every section collapsed to its headings; unfold per section or with 'unfold all'",
        get: () => mdUi.$().startFolded,
        set: (on) => setMdUi({ startFolded: on }),
      },
    ],
    instances: [{
      id: "md",
      prefix: "md:",
      componentName: "mdview-instance",
      component: MdInstance,
      // params.path is the whole state: the panel re-reads the doc on mount, so
      // an open markdown tab comes back after a reload. A path that has since
      // moved renders the load error in the tab (no wedged restore).
      restorable: true,
    }],
    routes: [
      {
        id: "markdown",
        open: (path) => {
          const ext = path.split(".").pop()?.toLowerCase() ?? "";
          if (!MD_EXTS.has(ext)) return false;
          openMarkdownPanel(path);
          return true;
        },
      },
    ],
  });
  // Per-tab content zoom (⌘+/-/0 while the panel is active). Declarative:
  // MdPanel reads the factor from store.panelZoom and styles the content.
  host.registerZoomKind({ prefix: "md:", min: 0.5, max: 2.5, step: 0.1 });
}
