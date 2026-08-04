import { describe, it, expect } from "vitest";
import { renderD2 } from "./d2";

describe("renderD2", () => {
  it("renders a valid d2 fence into an svg-bearing string", async () => {
    const svg = await renderD2("a -> b", false);
    expect(svg).toContain("<svg");
  });

  it("renders the dark theme for dark mode", async () => {
    const light = await renderD2("a -> b", false);
    const dark = await renderD2("a -> b", true);
    expect(light).toContain("<svg");
    expect(dark).toContain("<svg");
    expect(dark).not.toBe(light);
  });

  it("rejects on broken d2 source instead of throwing synchronously", async () => {
    let rejection: string | null = null;
    try {
      await renderD2("a: {", false);
    } catch (error) {
      rejection = error instanceof Error ? error.message : "unknown error";
    }
    expect(rejection).toBeTruthy();
  });
});
