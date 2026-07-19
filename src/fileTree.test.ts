import { describe, it, expect } from "vitest";
import { buildFileRows } from "./fileTree";
import type { FsEntry } from "./state";

const entry = (name: string, is_dir: boolean, ext = ""): FsEntry => ({
  name,
  path: `/r/${name}`,
  is_dir,
  size: 0,
  modified: 0,
  ext,
});

describe("buildFileRows", () => {
  it("marks dirs expandable but leaves children unloaded until expanded", () => {
    const rows = buildFileRows([entry("docs", true), entry("a.md", false, "md")], {}, {});
    expect(rows[0].kind).toBe("dir");
    expect(rows[0].children).toBeUndefined();
    expect(rows[1].kind).toBe("file");
    expect(rows[1].children).toBeUndefined();
  });

  it("materializes children of expanded dirs from the fsChildren cache", () => {
    const rows = buildFileRows(
      [entry("docs", true)],
      { "/r/docs": true },
      { "/r/docs": [entry("b.md", false, "md")] },
    );
    expect(rows[0].children?.map((c) => c.label)).toEqual(["b.md"]);
  });

  it("shows an expanded dir whose cache is still loading as empty", () => {
    const rows = buildFileRows([entry("docs", true)], { "/r/docs": true }, {});
    expect(rows[0].children).toEqual([]);
  });

  it("keeps deeper levels collapsed even when the parent is expanded", () => {
    const rows = buildFileRows(
      [entry("docs", true)],
      { "/r/docs": true },
      { "/r/docs": [entry("sub", true)] },
    );
    expect(rows[0].children?.[0].kind).toBe("dir");
    expect(rows[0].children?.[0].children).toBeUndefined();
  });
});
