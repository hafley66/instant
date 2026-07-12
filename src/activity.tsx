// Unified activity timeline (browser + os-capture + file events) and the Config
// panel (observation filters + plugin-declared option toggles). The React panels
// are presentational; derivation + handlers live here and pull rows() lazily.
import { invoke } from "./generated/native";
import {
  store,
  type ActivitySource,
  type CapturePerms,
  type ConfigView,
  type Event,
} from "./state";
import { setActivityPanel, type ActRow } from "./tablepanels";
import { fuzzyFilter } from "./fuzzy";
import { configOptions, type ConfigOption } from "./plugin";
import { fmtTime } from "./core";
import { useEffect } from "react";
import { useApp } from "./useStore";
import { openPreviewPanel } from "./preview";
import { pasteToActive } from "./terminal";
import { toggleRecording } from "./capture";

export const ACTIVITY_CAP = 2000;
const prettyUrl = (u: string) =>
  u.replace(/^https?:\/\//, "").replace(/^www\./, "");

// Where a row came from, for the source column: os captures show the frontmost
// app, browser rows the page title/host, file rows the file name.
function eventSource(e: Event): string {
  if (e.source === "os") return e.app || "screen";
  if (e.source === "files") return e.title || "file";
  return e.title || prettyUrl(e.url);
}
// The free-text payload fuzzy search runs over (and the search-key for a row).
function eventText(e: Event): string {
  return e.text || e.url || e.title;
}
function activityKey(e: Event): string {
  return `${e.kind} ${e.source} ${eventSource(e)} ${eventText(e)}`;
}

// Short source label for the row (the panel's one filter axis is source).
const SRC_LABEL: Record<Event["source"], string> = {
  os: "screen",
  browser: "web",
  files: "file",
  session: "session",
};
// Normalize the raw kind grab-bag into a small set of verbs for the row.
const ACTION_VERB: Record<string, string> = {
  nav: "visit",
  tabopen: "tab",
  tabclose: "tab",
  dblclick: "click",
  ctrlclick: "click",
  selection: "select",
  clipboard: "copy",
};
const actionVerb = (e: Event): string => ACTION_VERB[e.kind] ?? e.kind;

// The visible rows: source chip, then fuzzy search box.
function visibleActivity(): Event[] {
  const { activity, activitySource, activityQuery } = store.get();
  const filtered = activity.filter(
    (e) => activitySource === "all" || e.source === activitySource,
  );
  return fuzzyFilter(activityQuery, filtered, activityKey);
}

// Display-ready timeline rows for ActivityPanelV2. `title` mirrors v1's <tr
// title> (shot path wins, used by the global ctx-menu); `paste` is the
// dbl-click payload (text/url/title, never the shot path).
function actRows(): ActRow[] {
  return visibleActivity().map((e) => ({
    id: e.id,
    ts: e.ts,
    time: fmtTime(e.ts),
    source: e.source,
    src: SRC_LABEL[e.source],
    action: actionVerb(e),
    target: eventSource(e),
    title: e.shot || e.url || e.text || e.title,
    paste: eventText(e),
    kind: e.kind,
    // The previewable file path for this row, if any: a screenshot PNG (os) or
    // the logged file path (files). Routed to a split-right preview tab.
    filePath: e.shot || (e.source === "files" ? e.text : "") || undefined,
    shot: e.shot || undefined,
    url: e.url || undefined,
    text: e.text || undefined,
  }));
}

// Wire the ActivityPanelV2 bridge: derivation + handlers here, presentation in
// tablepanels.tsx. The panel re-renders on store change (useApp), so the
// record/chips/search state stays in the store, no DOM sync needed.
export function registerActivityBridge() {
  setActivityPanel({
    rows: actRows,
    count: () => ({
      shown: visibleActivity().length,
      total: store.get().activity.length,
    }),
    source: () => store.get().activitySource,
    setSource: (s) => store.set({ activitySource: s as ActivitySource }),
    query: () => store.get().activityQuery,
    setQuery: (q) => store.set({ activityQuery: q }),
    recording: () => store.get().captureEnabled,
    toggleRecord: () => toggleRecording(),
    clear: () =>
      invoke("activity_clear")
        .then(() => store.set({ activity: [] }))
        .catch(console.error),
    hasEvents: () => store.get().activity.length > 0,
    onActivate: (r) => {
      if (r.paste) pasteToActive(r.paste + " ");
    },
    // Any file-backed row (screenshot PNG or logged file) opens the shared
    // file-preview in a split-right tab.
    openPreview: (path) => openPreviewPanel(path, undefined, "right"),
    perms: () => store.get().capturePerms,
    status: () => store.get().captureStatus,
    refreshPerms: refreshCapturePerms,
    requestScreen: () => {
      invoke("capture_request_screen")
        // The grant may not register until the OS prompt is dismissed; re-probe
        // shortly after so the banner clears once it's granted.
        .then(() => setTimeout(refreshCapturePerms, 500))
        .catch(console.error);
    },
    onShow: () => {
      if (store.get().activity.length === 0) refreshActivity();
      refreshCapturePerms();
    },
  });
}

// Probe macOS TCC + tap state for the Activity panel's capture banner.
function refreshCapturePerms() {
  invoke<CapturePerms>("capture_permissions")
    .then((p) => store.set({ capturePerms: p }))
    .catch(console.error);
}

// Load all sources once; the chip + search filter client-side (visibleActivity).
async function refreshActivity() {
  try {
    store.set({
      activity: await invoke<Event[]>("activity_events", {
        limit: ACTIVITY_CAP,
        source: null,
      }),
    });
  } catch (e) {
    console.error("activity_events:", e);
  }
}

// ---- config: observation filters (config.json), editable readout ----
export async function refreshConfig() {
  try {
    store.set({ config: await invoke<ConfigView>("config_get") });
  } catch (e) {
    console.error("config_get:", e);
  }
}

// The panel's "Reload" button: forces a fresh re-read from disk (config_reload),
// distinct from refreshConfig's config_get (cached view, used for the initial
// mount fetch). Mirrors the wireChrome() handler this replaced.
async function reloadConfig() {
  try {
    store.set({ config: await invoke<ConfigView>("config_reload") });
  } catch (e) {
    console.error("config_reload:", e);
  }
}

// Persist a full set of rule lists and refresh the view from the backend.
async function applyConfig(sites: string[], files: string[], apps: string[]) {
  try {
    const view = await invoke<ConfigView>("config_set", {
      excludeSites: sites,
      excludeFiles: files,
      excludeApps: apps,
    });
    store.set({ config: view });
  } catch (e) {
    console.error("config_set:", e);
  }
}

// Options section for the Config panel: every config toggle declared by a
// plugin (see plugin.tsx configOptions). Renders nothing when none are
// declared. Reuses .cfg-group chrome so it sits with the rest.
function OptionsGroup() {
  const opts = configOptions();
  if (!opts.length) return null;
  return (
    <div className="cfg-group">
      <div className="cfg-group-head">
        <b>Options</b> <span className="muted">appearance &amp; behavior</span>
      </div>
      {opts.map((o) => (
        <OptionToggle key={o.id} option={o} />
      ))}
    </div>
  );
}

// xp.css draws its pixel checkbox only for the `input + label[for]` sibling
// pattern (it sets the raw input to opacity:0/position:fixed). So emit that
// exact structure, not a wrapping label, or the box never renders.
function OptionToggle({ option }: { option: ConfigOption }) {
  const id = `cfgopt-${option.id}`;
  return (
    <div className="cfg-toggle">
      <input
        type="checkbox"
        id={id}
        checked={option.get()}
        onChange={(e) => option.set(e.currentTarget.checked)}
      />
      <label htmlFor={id}>
        {option.label} <span className="muted">{option.hint ?? ""}</span>
      </label>
    </div>
  );
}

// One editable rule group: removable chips + an add input. onChange gets the
// full next list for this group.
function CfgGroup({
  title,
  hint,
  items,
  onChange,
}: {
  title: string;
  hint: string;
  items: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="cfg-group">
      <div className="cfg-group-head">
        <b>{title}</b> <span className="muted">{hint}</span>
      </div>
      <div className="cfg-chips">
        {items.map((pat, i) => (
          <span className="cfg-chip" key={pat}>
            {pat}
            <span className="cfg-x" onClick={() => onChange(items.filter((_, j) => j !== i))}>
              ×
            </span>
          </span>
        ))}
      </div>
      <form
        className="cfg-add"
        onSubmit={(e) => {
          e.preventDefault();
          const input = e.currentTarget.elements.namedItem("pattern") as HTMLInputElement;
          const v = input.value.trim();
          if (v && !items.includes(v)) onChange([...items, v]);
          input.value = "";
        }}
      >
        <input name="pattern" placeholder="add pattern…" autoComplete="off" />
        <button type="submit">+</button>
      </form>
    </div>
  );
}

export function ConfigPanelV2() {
  useApp();
  const cfg = store.get().config;
  useEffect(() => {
    if (!store.get().config) refreshConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div className="act-bar">
        <span className="spy-title">config</span>
        <span className="wt-count">
          {cfg ? `${cfg.source}` + (cfg.excluded_count ? ` · ${cfg.excluded_count} blocked` : "") : ""}
        </span>
        <span className="spy-spacer" />
        <button type="button" onClick={() => reloadConfig()}>
          Reload
        </button>
        <button type="button" onClick={() => invoke("config_open").catch(console.error)}>
          Open file
        </button>
      </div>
      <div className="cfg-body">
        {!cfg ? (
          <div className="empty-help">loading…</div>
        ) : (
          <>
            <OptionsGroup />
            <div className="cfg-status">
              <div>
                loaded from <b>{cfg.source}</b>
              </div>
              <code>{cfg.path}</code>
              {cfg.error ? <div className="cfg-err">⚠ {cfg.error} — using defaults</div> : null}
              <div className="muted">
                {cfg.excluded_count} events blocked since launch · patterns are case-insensitive;{" "}
                <code>*</code> is a wildcard
              </div>
            </div>
            <CfgGroup
              title="Sites"
              hint="browser URLs to ignore (e.g. mail.google.com, *.bank.com)"
              items={cfg.exclude_sites}
              onChange={(next) => applyConfig(next, cfg.exclude_files, cfg.exclude_apps)}
            />
            <CfgGroup
              title="Files"
              hint="file paths to ignore (e.g. /secret/, *.env)"
              items={cfg.exclude_files}
              onChange={(next) => applyConfig(cfg.exclude_sites, next, cfg.exclude_apps)}
            />
            <CfgGroup
              title="Apps"
              hint="never screenshot while these apps are frontmost (e.g. 1Password)"
              items={cfg.exclude_apps}
              onChange={(next) => applyConfig(cfg.exclude_sites, cfg.exclude_files, next)}
            />
          </>
        )}
      </div>
    </>
  );
}
