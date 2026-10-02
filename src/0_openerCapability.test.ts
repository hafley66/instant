import { describe, expect, it } from "vitest";
import capability from "../src-tauri/capabilities/default.json";
import conf from "../src-tauri/tauri.conf.json";

// The opener plugin rejects every openPath call unless the capability names a
// path scope: `opener:allow-open-path` alone allows nothing (plugin scope.rs
// is_path_allowed builds its fs scope from the permission's own entries).
// This pins the scope so the "external" buttons cannot silently die again.
describe("opener capability", () => {
  const permissions: Array<string | { identifier: string; allow?: Array<Record<string, string | undefined>> }> = capability.permissions;
  const scoped = (id: string) =>
    permissions.find((p): p is { identifier: string; allow?: Array<Record<string, string | undefined>> } => typeof p !== "string" && p.identifier === id);

  it("allows the explicit Chrome target for http and https", () => {
    expect(scoped("opener:allow-open-url")?.allow?.filter((e) => e.app === "Google Chrome")).toEqual([
      { url: "http://*", app: "Google Chrome" },
      { url: "https://*", app: "Google Chrome" },
    ]);
  });

  it("allows opening any absolute path", () => {
    const paths = scoped("opener:allow-open-path")?.allow?.map((e) => e.path) ?? [];
    expect(paths).toContain("/**");
  });

  it("allows http, https and file urls", () => {
    const urls = scoped("opener:allow-open-url")?.allow?.map((e) => e.url) ?? [];
    expect(urls).toEqual(expect.arrayContaining(["http://*", "https://*", "file://*"]));
  });

  it("lets dot-directories through the path glob", () => {
    expect(conf.plugins.opener.requireLiteralLeadingDot).toBe(false);
  });
});
