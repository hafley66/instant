// The mdview plugin: markdown viewer dock panels (`md:<path>`) plus the
// Config-panel toggle for the fold default. Routing callers (preview.ts,
// clickrules.ts) use openMarkdownPanel from ./open — re-exported here for
// convenience.
import { createElement, useCallback, useEffect } from "react";
import type { IDockviewPanelProps } from "dockview";
import { registerPlugin } from "../plugin";
import { registerZoomKind } from "../panelZoom";
import { baseName } from "../core";
import { MdPanel } from "./MdPanel";
import { mdUi, pathSignalFor, setMdUi } from "./signals";
import { registerMdNav } from "./open";

export { openMarkdownPanel } from "./open";

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
    },
    [pid, props.api, sig],
  );
  useEffect(() => registerMdNav(pid, navigate), [pid, navigate]);
  return createElement(MdPanel, { pid, pathSig: sig, onNavigate: navigate });
}

export function registerMdview() {
  registerPlugin({
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
    }],
  });
  // Per-tab content zoom (⌘+/-/0 while the panel is active). Declarative:
  // MdPanel reads the factor from store.panelZoom and styles the content.
  registerZoomKind({ prefix: "md:", min: 0.5, max: 2.5, step: 0.1 });
}
