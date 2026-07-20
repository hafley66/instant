import { describe, expect, it } from "vitest";
import {
  type Rule,
  applyCellEdit,
  formatSchedule,
  nextRuleId,
  parseSchedule,
  scheduleLabel,
  validateRegex,
} from "./rulesModel";

const base: Rule = {
  id: "rule-1",
  host: "example\\.com",
  mode: "textnodes",
  regex: "(\\d+)",
  captures: { "1": "value" },
  schedule: "passive",
  enabled: true,
};

describe("parseSchedule", () => {
  it("accepts passive (any case) and trims", () => {
    expect(parseSchedule("passive")).toEqual({ ok: true, value: "passive" });
    expect(parseSchedule("  PASSIVE ")).toEqual({ ok: true, value: "passive" });
  });
  it("accepts positive integer minutes", () => {
    expect(parseSchedule("5")).toEqual({ ok: true, value: { intervalMin: 5 } });
    expect(parseSchedule(" 10 ")).toEqual({ ok: true, value: { intervalMin: 10 } });
  });
  it("rejects zero, non-integers, and junk", () => {
    expect(parseSchedule("0").ok).toBe(false);
    expect(parseSchedule("5m").ok).toBe(false);
    expect(parseSchedule("1.5").ok).toBe(false);
    expect(parseSchedule("").ok).toBe(false);
    expect(parseSchedule("abc").ok).toBe(false);
  });
});

describe("schedule label vs edit value", () => {
  it("labels with a trailing m but edits as a bare number", () => {
    expect(scheduleLabel({ intervalMin: 5 })).toBe("5m");
    expect(formatSchedule({ intervalMin: 5 })).toBe("5");
    expect(scheduleLabel("passive")).toBe("passive");
    expect(formatSchedule("passive")).toBe("passive");
    expect(scheduleLabel(undefined)).toBe("");
    expect(formatSchedule(undefined)).toBe("");
  });
  it("round-trips through parseSchedule", () => {
    const p = parseSchedule(formatSchedule({ intervalMin: 7 }));
    expect(p).toEqual({ ok: true, value: { intervalMin: 7 } });
  });
});

describe("validateRegex", () => {
  it("returns null for a valid pattern", () => {
    expect(validateRegex("(\\d+)")).toBeNull();
  });
  it("returns a message for an invalid pattern", () => {
    expect(validateRegex("(")).not.toBeNull();
  });
});

describe("applyCellEdit", () => {
  it("maps select fields when valid and rejects bad options", () => {
    const mode = applyCellEdit(base, "mode", "selector");
    expect(mode).toEqual({ ok: true, rule: { ...base, mode: "selector" } });
    expect(applyCellEdit(base, "mode", "nope").ok).toBe(false);

  });

  it("validates host and regex as RegExp", () => {
    expect(applyCellEdit(base, "host", "sub\\.example\\.com").ok).toBe(true);
    expect(applyCellEdit(base, "host", "(").ok).toBe(false);
    expect(applyCellEdit(base, "regex", "(bad").ok).toBe(false);
    const ok = applyCellEdit(base, "regex", "(\\w+)");
    expect(ok).toEqual({ ok: true, rule: { ...base, regex: "(\\w+)" } });
  });

  it("clears optional text fields when emptied", () => {
    const url = applyCellEdit({ ...base, url: "https://x" }, "url", "");
    expect(url).toEqual({ ok: true, rule: { ...base, url: undefined } });
    const sel = applyCellEdit({ ...base, selector: ".x" }, "selector", "   ");
    expect(sel).toEqual({ ok: true, rule: { ...base, selector: undefined } });
    const rx = applyCellEdit(base, "regex", "");
    expect(rx).toEqual({ ok: true, rule: { ...base, regex: undefined } });
  });

  it("maps schedule via parseSchedule", () => {
    expect(applyCellEdit(base, "schedule", "15")).toEqual({
      ok: true,
      rule: { ...base, schedule: { intervalMin: 15 } },
    });
    expect(applyCellEdit(base, "schedule", "nope").ok).toBe(false);
  });

  it("rejects read-only id and unknown columns", () => {
    expect(applyCellEdit(base, "id", "rule-9").ok).toBe(false);
    expect(applyCellEdit(base, "enabled", "true").ok).toBe(false);
  });
});

describe("nextRuleId", () => {
  it("avoids collisions after a delete", () => {
    // [rule-1, rule-3] -> length+1 = 3 collides; must skip to rule-4.
    const rules: Rule[] = [base, { ...base, id: "rule-3" }];
    expect(nextRuleId(rules)).toBe("rule-4");
  });
  it("uses length+1 when free", () => {
    expect(nextRuleId([base])).toBe("rule-2");
    expect(nextRuleId([])).toBe("rule-1");
  });
});
