// React shell for the Sprefa plugin panel. All schema/scope/scratch logic
// lives in sprefa.ts and is untouched by this conversion -- it already worked
// entirely through querySelector against these same ids, so mounting it inside
// a real DOM subtree changes nothing for it. This file only supplies the JSX
// markup (mirrors the old injected html 1:1) and the mount-time wiring:
// component-based panels don't get PanelDef.onShow (see tablepanels.tsx), so
// the wireSprefa()/loadSprefaSchema() pair that used to run on every "show"
// now runs on every mount instead -- the same lazy-per-visit semantics.
import { useEffect } from "react";
import { wireSprefa, loadSprefaSchema } from "./sprefa";

const SCRATCH_PLACEHOLDER = `scratch datalog — runtime-only, nothing saved.

rel hot(name: text, line: int).
hot(name, line) <-
  scan("WORK", "**/*.rs", p, rev),
  match(p, rev, /fn\\s+(?<name>[a-z_]+)/, line).
? hot(name, line).`;

export function SprefaPanelV2() {
  useEffect(() => {
    wireSprefa();
    loadSprefaSchema();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <form id="sprefa-bar" className="wt-scan">
        <input id="sprefa-root" autoComplete="off" spellCheck={false} />
        <button type="submit">Load</button>
        <button id="sprefa-tab-schema" type="button" className="sprefa-tab on">
          Schema
        </button>
        <button id="sprefa-tab-scratch" type="button" className="sprefa-tab">
          Scratch
        </button>
        <span id="sprefa-status" className="wt-count" />
      </form>
      <div id="sprefa-schema" className="wt-tree" />
      <div id="sprefa-scratch" hidden>
        <div id="sprefa-scope" className="sprefa-scope" />
        <textarea id="sprefa-scratch-src" className="sprefa-scratch-src" spellCheck={false} placeholder={SCRATCH_PLACEHOLDER} />
        <div className="sprefa-scratch-bar">
          <button id="sprefa-run" type="button">
            Run ⌘↵
          </button>
          <span id="sprefa-scratch-status" className="wt-count" />
        </div>
        <div id="sprefa-scratch-out" className="sprefa-scratch-out" />
      </div>
    </>
  );
}
