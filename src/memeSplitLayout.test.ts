import { describe, it, expect } from "vitest";
import {
  clampPercent,
  pxToPercent,
  migrateLegacyLayout,
  sidebarBoundsPct,
  layersBoundsPct,
  DEFAULT_SIDEBAR_PCT,
  DEFAULT_LAYERS_PCT,
} from "./memeSplitLayout";

describe("memeSplitLayout.ts", () => {
  describe("clampPercent", () => {
    it("passes values already in range through unchanged", () => {
      expect(clampPercent(42)).toBe(42);
    });

    it("clamps below 0 up to 0", () => {
      expect(clampPercent(-10)).toBe(0);
    });

    it("clamps above 100 down to 100", () => {
      expect(clampPercent(150)).toBe(100);
    });

    it("treats non-finite input as 0", () => {
      expect(clampPercent(NaN)).toBe(0);
      expect(clampPercent(Infinity)).toBe(0);
    });
  });

  describe("pxToPercent", () => {
    it("converts px to a percentage of the container", () => {
      expect(pxToPercent(120, 600)).toBe(20);
    });

    it("returns 0 when the container has no measured size yet", () => {
      expect(pxToPercent(120, 0)).toBe(0);
    });

    it("returns 0 for a negative container size", () => {
      expect(pxToPercent(120, -100)).toBe(0);
    });

    it("clamps to 100 when px exceeds the container", () => {
      expect(pxToPercent(900, 600)).toBe(100);
    });
  });

  describe("migrateLegacyLayout", () => {
    it("converts legacy sidebarWidth/layersHeight px into an outer/inner percentage layout", () => {
      const layout = migrateLegacyLayout({ sidebarWidth: 200, layersHeight: 100 }, 1000, 500);
      expect(layout).toEqual({
        outer: [20, 80],
        inner: [80, 20],
      });
    });

    it("falls back to the default split when there is nothing to migrate", () => {
      const layout = migrateLegacyLayout({}, 1000, 500);
      expect(layout).toEqual({
        outer: [DEFAULT_SIDEBAR_PCT, 100 - DEFAULT_SIDEBAR_PCT],
        inner: [100 - DEFAULT_LAYERS_PCT, DEFAULT_LAYERS_PCT],
      });
    });

    it("migrates sidebarWidth alone, defaulting the layers split", () => {
      const layout = migrateLegacyLayout({ sidebarWidth: 300 }, 1000, 500);
      expect(layout.outer).toEqual([30, 70]);
      expect(layout.inner).toEqual([100 - DEFAULT_LAYERS_PCT, DEFAULT_LAYERS_PCT]);
    });
  });

  describe("sidebarBoundsPct", () => {
    it("converts the 120-400px legacy clamp into percentages of the container width", () => {
      expect(sidebarBoundsPct(1000)).toEqual({ min: 12, max: 40 });
    });
  });

  describe("layersBoundsPct", () => {
    it("converts the 80-400px legacy clamp into percentages of the container height", () => {
      expect(layersBoundsPct(500)).toEqual({ min: 16, max: 80 });
    });
  });
});
