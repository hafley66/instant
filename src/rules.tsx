// Rules panel: the control center for the extension's config-driven core.
// instant is the source of truth (rules.json, served at GET /config); this panel
// reads/writes it via the rules_get / rules_set commands. Raw-JSON editing per
// rule is the milestone-1 editor, selected via the grid. A live feed tails
// `rule-match` events emitted by the ingest server so you can see rules firing
// as you browse. Both lists are flat one-level TreeTables (AGENTS.md: no
// bespoke row markup — reuse the grid stack).
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { registerPlugin } from "./plugin";
import { TreeTable, type TreeColumn } from "./treetable";

type RuleMode = "textnodes" | "selector" | "netcapture";

interface Rule {
  id: string;
  host: string;
  url?: string;
  mode: RuleMode;
  selector?: string;
  regex?: string;
  captures?: Record<string, string>;
  schedule?: { intervalMin: number } | "passive";
  action: "report" | "notify";
  enabled?: boolean;
}

// rule-match payload (Rust RuleMatch, serialized with ruleId).
interface RuleMatch {
  ruleId: string;
  url: string;
  ts: number;
  matches: Record<string, string>[];
}

const FEED_CAP = 100;

function template(n: number): Rule {
  return {
    id: `rule-${n}`,
    host: "example\\.com",
    mode: "textnodes",
    regex: "(\\d+)",
    captures: { "1": "value" },
    schedule: "passive",
    action: "report",
    enabled: true,
  };
}

function scheduleLabel(s: Rule["schedule"]): string {
  if (s == null) return "";
  if (s === "passive") return "passive";
  return `${s.intervalMin}m`;
}

function matchFields(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
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

  useEffect(() => {
    invoke<Rule[]>("rules_get").then(setRules).catch(console.error);
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
  // next /config tick, <= 1 min).
  function save(next: Rule[]) {
    invoke<Rule[]>("rules_set", { rules: next })
      .then(setRules)
      .catch((e) => console.error(e));
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
    save([...rules, template(rules.length + 1)]);
  }
  function edit(id: string) {
    setSelected(id);
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

  // Raw-JSON edit for the selected rule. Parse on Apply; a bad body shows
  // inline and leaves the stored rule untouched.
  function applyDraft(id: string) {
    const body = drafts[id];
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
    },
    { id: "mode", header: "mode", sortValue: (r) => r.mode, cell: (r) => r.mode },
    {
      id: "schedule",
      header: "schedule",
      sortValue: (r) => scheduleLabel(r.schedule),
      cell: (r) => scheduleLabel(r.schedule),
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
      </div>
      <div className="panel-scroll">
        {rules.length === 0 ? (
          <div className="session-empty">no rules — served at GET /config</div>
        ) : (
          <TreeTable<Rule>
            columns={RULES_COLUMNS}
            data={rules}
            getRowId={(r) => r.id}
            rowClass={(r) => (r.id === selected ? "fs-selected" : undefined)}
            onRowClick={(r) => edit(r.id)}
          />
        )}

        {selectedRule ? (
          <div className="rule-editor">
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
          </div>
        ) : null}

        <div className="act-bar rules-feed-head">
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
