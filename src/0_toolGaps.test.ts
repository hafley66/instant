import { describe, expect, it } from "vitest";
import { gapKey, shouldNotify, summarizeToolGaps, type ToolStatus } from "./0_toolGaps";

const tool = (name: string, present: boolean): ToolStatus => ({
  name,
  present,
  purpose: `${name} purpose`,
  install: `brew install ${name}`,
});

describe("summarizeToolGaps", () => {
  it("reports nothing missing when every tool resolved", () => {
    const summary = summarizeToolGaps([tool("git", true), tool("tmux", true)]);
    expect(summary.missing).toEqual([]);
    expect(summary.headline).toBe("all mainline tools present");
  });

  it("orders gaps by name so the banner text is stable across boots", () => {
    const summary = summarizeToolGaps([tool("tmux", false), tool("git", true), tool("rg", false)]);
    expect(summary.missing.map((t) => t.name)).toEqual(["rg", "tmux"]);
    expect(summary.headline).toBe("rg, tmux not installed");
  });

  it("keeps the install hint on the rendered line, the only place it appears", () => {
    const summary = summarizeToolGaps([tool("rg", false)]);
    expect(summary.lines).toEqual(["rg — rg purpose\n    install: brew install rg"]);
  });
});

describe("shouldNotify", () => {
  it("stays quiet on a healthy machine, which is every boot for most users", () => {
    expect(shouldNotify([], null)).toBe(false);
  });

  it("fires the first time a gap set is seen", () => {
    expect(shouldNotify([tool("rg", false)], null)).toBe(true);
  });

  it("stays quiet once that exact set was dismissed", () => {
    const missing = [tool("rg", false)];
    expect(shouldNotify(missing, gapKey(missing))).toBe(false);
  });

  it("fires again when a new tool joins a dismissed set", () => {
    const dismissed = gapKey([tool("rg", false)]);
    expect(shouldNotify([tool("rg", false), tool("tmux", false)], dismissed)).toBe(true);
  });

  it("keys on the set, not the order it arrived in", () => {
    expect(gapKey([tool("tmux", false), tool("rg", false)])).toBe(gapKey([tool("rg", false), tool("tmux", false)]));
  });
});
