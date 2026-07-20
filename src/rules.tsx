// Rules panel: the control center for the extension's config-driven core.
// instant is the source of truth (rules.json, served at GET /config); this panel
// reads/writes it via the rules_get / rules_set commands. Raw-JSON editing per
// rule is the milestone-1 editor, selected via the grid. A live feed tails
// `rule-match` events emitted by the ingest server so you can see rules firing
// as you browse. Both lists are flat one-level TreeTables (AGENTS.md: no
// bespoke row markup — reuse the grid stack).
import { useEffect, useState } from "react";
import { invoke } from "./generated/native";
import { listen } from "@tauri-apps/api/event";
import { registerPlugin } from "./plugin";
import { TreeTable, type TreeColumn } from "./treetable";
import { flashStatus, showError } from "./core";
import claudeUsageRuleJson from "./plugins/metrics/0_claude-usage.rule.json";
import {
  type Rule,
  type RuleMatch,
  RULE_MODES,
  scheduleLabel,
  formatSchedule,
  applyCellEdit,
  nextRuleId,
} from "./rulesModel";

const FEED_CAP = 100;
const WATCHER_STALE_MS = 3 * 60 * 1000;
const RULE_SECTION_IDS = { watcher: "rules-watcher", table: "rules-table", selected: "rules-selected", matches: "rules-matches" } as const;
const CLAUDE_USAGE_RULE = claudeUsageRuleJson as unknown as Rule;

interface WatcherStatus {
  last_heartbeat: number;
  config_revision: number;
  rules_count: number;
}

function watcherLabel(status: WatcherStatus): string {
  if (!status.last_heartbeat) return "extension offline";
  return Date.now() - status.last_heartbeat <= WATCHER_STALE_MS ? "extension active" : "extension stale";
}

function template(id: string): Rule {
  return {
    id,
    host: "example\\.com",
    mode: "textnodes",
    regex: "(\\d+)",
    captures: { "1": "value" },
    schedule: "passive",
    enabled: true,
  };
}

function matchFields(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" · ");
}

// Trailing actions: edit (selects the rule for the JSON editor below) + delete.
function RuleActionsCell({
  row,
  onEdit,
  onDelete,
}: {
  row: Rule;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <span className="wt-actions">
      <button
        className="wt-act"
        title="edit raw JSON"
        onClick={(e) => {
          e.stopPropagation();
          onEdit(row.id);
        }}
      >
        edit
      </button>
      <button
        className="wt-act"
        title="delete rule"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(row.id);
        }}
      >
        ×
      </button>
    </span>
  );
}

function EnabledCell({ row, onToggle }: { row: Rule; onToggle: (id: string) => void }) {
  return (
    <input
      type="checkbox"
      checked={row.enabled !== false}
      title="enabled"
      onClick={(e) => e.stopPropagation()}
      onChange={() => onToggle(row.id)}
    />
  );
}

const MATCH_COLUMNS: TreeColumn<RuleMatch & { key: string }>[] = [
  {
    id: "ts",
    header: "time",
    sortValue: (m) => m.ts,
    cell: (m) => new Date(m.ts).toLocaleTimeString(),
  },
  { id: "ruleId", header: "rule", sortValue: (m) => m.ruleId, cell: (m) => m.ruleId },
  {
    id: "url",
    header: "url",
    sortValue: (m) => m.url,
    cell: (m) => (
      <span className="rm-url" title={m.url}>
        {m.url}
      </span>
    ),
  },
  {
    id: "matches",
    header: "matches",
    cell: (m) => (
      <span className="rm-fields">
        {m.matches.map((fields, j) => (
          <span className="rm-rec" key={j}>
            {matchFields(fields)}
          </span>
        ))}
      </span>
    ),
  },
];

export function RulesPanelV2() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [feed, setFeed] = useState<RuleMatch[]>([]);
  const [watcher, setWatcher] = useState<WatcherStatus>({
    last_heartbeat: 0,
    config_revision: 0,
    rules_count: 0,
  });

  function refreshWatcher() {
    invoke<WatcherStatus>("watcher_status").then(setWatcher).catch(console.error);
  }

  useEffect(() => {
    invoke<Rule[]>("rules_get").then(setRules).catch(console.error);
    invoke<RuleMatch[]>("activity_rule_matches", { limit: FEED_CAP }).then(setFeed).catch(console.error);
    refreshWatcher();
    const timer = window.setInterval(refreshWatcher, 2_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const un = listen<RuleMatch>("rule-match", (e) => {
      setFeed((f) => [e.payload, ...f].slice(0, FEED_CAP));
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // Persist and adopt the server's echoed list (the extension picks it up on its
  // next /config tick, <= 1 min). Surface failures — a swallowed rules_set
  // rejection is exactly the "edit isn't working" symptom (nothing changes, no
  // feedback).
  function save(next: Rule[]) {
    invoke<Rule[]>("rules_set", { rules: next })
      .then(setRules)
      .catch((e) => showError("rules", e));
  }

  function toggle(id: string) {
    save(rules.map((r) => (r.id === id ? { ...r, enabled: r.enabled === false } : r)));
  }
  function remove(id: string) {
    save(rules.filter((r) => r.id !== id));
    setDrafts((d) => {
      const { [id]: _drop, ...rest } = d;
      return rest;
    });
    setSelected((s) => (s === id ? null : s));
  }
  function add() {
    save([...rules, template(nextRuleId(rules))]);
  }
  function addClaudeUsage() {
    if (!rules.some((r) => r.id === CLAUDE_USAGE_RULE.id)) save([...rules, CLAUDE_USAGE_RULE]);
  }
  function edit(id: string) {
    setSelected(id);
  }
  // Inline grid edit: map the (columnId, string) back to a Rule field, validate,
  // persist. Bad regex / non-integer schedule flashes and never persists.
  function onCellEdit(row: Rule, columnId: string, value: string) {
    const res = applyCellEdit(row, columnId, value);
    if (!res.ok) {
      flashStatus(res.error);
      return;
    }
    save(rules.map((r) => (r.id === row.id ? res.rule : r)));
  }
  function cancelEdit() {
    if (selected) {
      setDrafts((d) => {
        const { [selected]: _drop, ...rest } = d;
        return rest;
      });
    }
    setSelected(null);
  }

  // Raw-JSON edit for the selected rule (escape hatch for `captures`). Parse on
  // Apply; a bad body shows inline and leaves the stored rule untouched. Falls
  // back to the current rule's JSON so Apply works even with no keystroke (the
  // shown default isn't seeded into `drafts`).
  function applyDraft(id: string) {
    const current = rules.find((r) => r.id === id);
    const body = drafts[id] ?? (current ? JSON.stringify(current, null, 2) : undefined);
    if (body == null) return;
    let parsed: Rule;
    try {
      parsed = JSON.parse(body) as Rule;
    } catch (e) {
      setErrors((x) => ({ ...x, [id]: String(e) }));
      return;
    }
    setErrors((x) => {
      const { [id]: _drop, ...rest } = x;
      return rest;
    });
    save(rules.map((r) => (r.id === id ? parsed : r)));
    setDrafts((d) => {
      const { [id]: _drop, ...rest } = d;
      return rest;
    });
  }

  // Double-click (or Enter on a focused row) edits inline; id is read-only,
  // enabled is the toggle, captures live in the raw-JSON pane. The schedule cell
  // reads "5m"/"passive" but edits as bare minutes/"passive" (getEditValue).
  const RULES_COLUMNS: TreeColumn<Rule>[] = [
    { id: "id", header: "id", sortValue: (r) => r.id, cell: (r) => r.id },
    {
      id: "host",
      header: "host",
      sortValue: (r) => r.host,
      cell: (r) => (
        <span className="rule-host" title={r.host}>
          {r.host}
        </span>
      ),
      edit: { kind: "text" },
      getEditValue: (r) => r.host,
    },
    {
      id: "url",
      header: "url",
      sortValue: (r) => r.url ?? "",
      cell: (r) => (r.url ? <span className="rule-host" title={r.url}>{r.url}</span> : ""),
      edit: { kind: "text" },
      getEditValue: (r) => r.url ?? "",
    },
    {
      id: "mode",
      header: "mode",
      sortValue: (r) => r.mode,
      cell: (r) => r.mode,
      edit: { kind: "select", options: RULE_MODES },
      getEditValue: (r) => r.mode,
    },
    {
      id: "selector",
      header: "selector",
      sortValue: (r) => r.selector ?? "",
      cell: (r) => r.selector ?? "",
      edit: { kind: "text" },
      getEditValue: (r) => r.selector ?? "",
    },
    {
      id: "regex",
      header: "regex",
      sortValue: (r) => r.regex ?? "",
      cell: (r) => r.regex ?? "",
      edit: { kind: "text" },
      getEditValue: (r) => r.regex ?? "",
    },
    {
      id: "schedule",
      header: "schedule",
      sortValue: (r) => scheduleLabel(r.schedule),
      cell: (r) => scheduleLabel(r.schedule),
      edit: { kind: "text" },
      getEditValue: (r) => formatSchedule(r.schedule),
    },
    {
      id: "enabled",
      header: "on",
      noRowClick: true,
      cell: (r) => <EnabledCell row={r} onToggle={toggle} />,
    },
    {
      id: "actions",
      header: "",
      noRowClick: true,
      cell: (r) => <RuleActionsCell row={r} onEdit={edit} onDelete={remove} />,
    },
  ];

  const selectedRule = selected ? rules.find((r) => r.id === selected) : undefined;
  const draft = selectedRule ? (drafts[selectedRule.id] ?? JSON.stringify(selectedRule, null, 2)) : "";

  return (
    <div className="v2-panel rules-panel">
      <div className="act-bar">
        <span className="spy-title">rules</span>
        <span className="wt-count">{rules.length}</span>
        <span className="spy-spacer" />
        <button type="button" onClick={add}>
          + Rule
        </button>
        {!rules.some((r) => r.id === CLAUDE_USAGE_RULE.id) ? (
          <button type="button" onClick={addClaudeUsage}>
            + Claude usage
          </button>
        ) : null}
        <button type="button" onClick={refreshWatcher} title="refresh extension status">
          refresh
        </button>
      </div>
      <div className="panel-scroll">
        <div id={RULE_SECTION_IDS.watcher} className="rules-section rules-status-row">
          <span>{watcherLabel(watcher)}</span>
          <span>config r{watcher.config_revision}</span>
          <span>{watcher.rules_count} cached</span>
          <span>last config fetch {watcher.last_heartbeat ? new Date(watcher.last_heartbeat).toLocaleTimeString() : "none"}</span>
          <span>last match {feed[0] ? new Date(feed[0].ts).toLocaleTimeString() : "none"}</span>
          <span>server 127.0.0.1:8787</span>
          <span className="spy-spacer" />
          <span>{watcher.last_heartbeat ? "heartbeat" : "no heartbeat"}</span>
        </div>
        <div id={RULE_SECTION_IDS.table} className="rules-section">
          {rules.length === 0 ? (
            <div className="session-empty">no rules — served at GET /config</div>
          ) : (
            <TreeTable<Rule>
              columns={RULES_COLUMNS}
              data={rules}
              getRowId={(r) => r.id}
              rowClass={(r) => (r.id === selected ? "fs-selected" : undefined)}
              onRowClick={(r) => edit(r.id)}
              onCellEdit={onCellEdit}
            />
          )}
        </div>

        <div id={RULE_SECTION_IDS.selected} className="rules-section rule-editor">
          {selectedRule ? (
            <>
              <textarea
                className="rule-json"
                spellCheck={false}
                value={draft}
                onChange={(e) =>
                  setDrafts((d) => ({ ...d, [selectedRule.id]: e.target.value }))
                }
              />
              {errors[selectedRule.id] ? (
                <div className="rule-error">{errors[selectedRule.id]}</div>
              ) : null}
              <div className="rule-actions">
                <button type="button" onClick={() => applyDraft(selectedRule.id)}>
                  Apply
                </button>
                <button type="button" onClick={cancelEdit}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <div className="session-empty">select a rule to edit its raw JSON</div>
          )}
        </div>

        <div id={RULE_SECTION_IDS.matches} className="rules-section act-bar rules-feed-head">
          <span className="spy-title">matches</span>
          <span className="wt-count">{feed.length}</span>
          <span className="spy-spacer" />
          {feed.length ? (
            <button type="button" onClick={() => setFeed([])}>
              Clear
            </button>
          ) : null}
        </div>
        {feed.length === 0 ? (
          <div className="session-empty">no matches yet</div>
        ) : (
          <TreeTable<RuleMatch & { key: string }>
            columns={MATCH_COLUMNS}
            data={feed.map((m, i) => ({ ...m, key: `${m.ts}-${i}` }))}
            getRowId={(m) => m.key}
            defaultSorting={[{ id: "ts", desc: true }]}
            rowTitle={(m) => m.url}
          />
        )}
      </div>
    </div>
  );
}

export function registerRulesPlugin() {
  registerPlugin({
    id: "rules",
    panels: [
      {
        id: "rules",
        title: "Rules",
        icon: "⚑",
        iconLabel: "Rules",
        html: "",
        component: RulesPanelV2,
      },
    ],
  });
}
