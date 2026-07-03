// Rules panel: the control center for the extension's config-driven core.
// instant is the source of truth (rules.json, served at GET /config); this panel
// reads/writes it via the rules_get / rules_set commands. Raw-JSON editing per
// rule is the milestone-1 editor. A live feed tails `rule-match` events emitted
// by the ingest server so you can see rules firing as you browse.
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { registerPlugin } from "./plugin";

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

export function RulesPanelV2() {
  const [rules, setRules] = useState<Rule[]>([]);
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
  }
  function add() {
    save([...rules, template(rules.length + 1)]);
  }

  // Raw-JSON edit for one rule. Parse on Apply; a bad body shows inline and
  // leaves the stored rule untouched.
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
          rules.map((r) => {
            const draft = drafts[r.id] ?? JSON.stringify(r, null, 2);
            const editing = drafts[r.id] != null;
            return (
              <div className="rule-row" key={r.id}>
                <div className="rule-head">
                  <input
                    type="checkbox"
                    checked={r.enabled !== false}
                    onChange={() => toggle(r.id)}
                    title="enabled"
                  />
                  <span className="rule-id">{r.id}</span>
                  <span className="rule-mode">{r.mode}</span>
                  <span className="rule-host" title={r.host}>
                    {r.host}
                  </span>
                  <span className="spy-spacer" />
                  <button type="button" onClick={() => remove(r.id)} title="delete">
                    ✕
                  </button>
                </div>
                <textarea
                  className="rule-json"
                  spellCheck={false}
                  value={draft}
                  onChange={(e) => setDrafts((d) => ({ ...d, [r.id]: e.target.value }))}
                />
                {errors[r.id] ? <div className="rule-error">{errors[r.id]}</div> : null}
                {editing ? (
                  <div className="rule-actions">
                    <button type="button" onClick={() => applyDraft(r.id)}>
                      Apply
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setDrafts((d) => {
                          const { [r.id]: _drop, ...rest } = d;
                          return rest;
                        })
                      }
                    >
                      Cancel
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })
        )}

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
          feed.map((m, i) => (
            <div className="rule-match" key={`${m.ts}-${i}`}>
              <div className="rm-head">
                <span className="rm-id">{m.ruleId}</span>
                <span className="rm-url" title={m.url}>
                  {m.url}
                </span>
              </div>
              <div className="rm-fields">
                {m.matches.map((fields, j) => (
                  <span className="rm-rec" key={j}>
                    {Object.entries(fields)
                      .map(([k, v]) => `${k}=${v}`)
                      .join(" · ")}
                  </span>
                ))}
              </div>
            </div>
          ))
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
