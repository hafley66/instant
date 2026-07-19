// The mdview plugin: markdown viewer dock panels (`md:<path>`) plus the
// Config-panel toggle for the fold default. Routing callers (preview.ts,
// clickrules.ts) use openMarkdownPanel from ./open — re-exported here for
// convenience.
import { createElement } from "react";
import type { IDockviewPanelProps } from "dockview";
import { registerPlugin } from "../plugin";
import { registerDockComponent } from "../reactdock";
import { MdPanel } from "./MdPanel";
import { mdUi, setMdUi } from "./signals";

export { openMarkdownPanel } from "./open";

function MdInstance(props: IDockviewPanelProps) {
  const path = String(props.params.path ?? "");
  return createElement(MdPanel, { path });
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
  });
  registerDockComponent("mdview-instance", MdInstance);
}
