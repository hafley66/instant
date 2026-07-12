import { describe, expect, it } from "vitest";
import { detectHarness, trimOutputTail } from "./harness";

describe("harness detection", () => {
  it("prefers an explicit launch command", () => {
    const found = detectHarness("opencode --session abc", "node", "");
    expect(found.id).toBe("opencode");
    expect(found.confidence).toBe("medium");
    expect(found.evidence).toContain("opencode:command");
  });

  it("uses visible output when the tab started as a shell", () => {
    const found = detectHarness("zsh", "node", "Welcome to Claude Code\n⏺ answer");
    expect(found.id).toBe("claude");
    expect(found.evidence).toContain("claude:output");
  });

  it("does not claim an unknown shell", () => {
    expect(detectHarness("zsh", "zsh").id).toBeNull();
  });

  it("keeps only the bounded output tail", () => {
    expect(trimOutputTail("12345", "6789", 6)).toBe("456789");
  });
});
