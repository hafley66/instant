import { describe, it, expect } from "vitest";
import { candidatePaths, rankSearchHits, looksLikePath } from "./refResolve";

const file = (path: string) => ({
  path,
  name: path.split("/").pop() ?? path,
  is_dir: false,
});

describe("looksLikePath", () => {
  it("accepts paths and extension-bearing names", () => {
    expect(looksLikePath("src/main.ts")).toBe(true);
    expect(looksLikePath("MdPanel.tsx")).toBe(true);
    expect(looksLikePath("~/notes.md")).toBe(true);
  });

  it("rejects bare words and urls", () => {
    expect(looksLikePath("renderPathInto")).toBe(false);
    expect(looksLikePath("https://example.com/a.ts")).toBe(false);
  });
});

describe("candidatePaths", () => {
  it("leaves an absolute or home path alone", () => {
    expect(candidatePaths("/a/b.ts", "/repo/src", "/repo")).toEqual(["/a/b.ts"]);
    expect(candidatePaths("~/b.ts", "/repo/src", "/repo")).toEqual(["~/b.ts"]);
  });

  it("tries the cwd before the repo root", () => {
    expect(candidatePaths("src/main.ts", "/repo/pkg", "/repo")).toEqual([
      "/repo/pkg/src/main.ts",
      "/repo/src/main.ts",
    ]);
  });

  it("emits one candidate when the cwd is the repo root", () => {
    expect(candidatePaths("src/main.ts", "/repo", "/repo")).toEqual(["/repo/src/main.ts"]);
    expect(candidatePaths("src/main.ts", "/repo/", "/repo")).toEqual(["/repo/src/main.ts"]);
  });

  it("normalizes a leading ./ and a trailing slash on the base", () => {
    expect(candidatePaths("./src/main.ts", "/repo/", null)).toEqual(["/repo/src/main.ts"]);
  });

  it("falls back to the raw token with no cwd and no root", () => {
    expect(candidatePaths("src/main.ts", "", null)).toEqual(["src/main.ts"]);
  });
});

describe("rankSearchHits", () => {
  const entries = [
    file("/repo/e2e/fixtures/deep/nested/main.ts"),
    file("/repo/src/main.ts"),
    file("/repo/src/mdview/MdPanel.tsx"),
    file("/repo/vendor/copy/src/main.ts"),
    file("/repo/src/other.ts"),
  ];

  it("prefers a full tail match over a filename match", () => {
    expect(rankSearchHits("src/main.ts", entries)).toEqual([
      "/repo/src/main.ts",
      "/repo/vendor/copy/src/main.ts",
      "/repo/e2e/fixtures/deep/nested/main.ts",
    ]);
  });

  it("ranks the shallowest path first for a bare filename", () => {
    expect(rankSearchHits("main.ts", entries)[0]).toBe("/repo/src/main.ts");
  });

  it("returns a single match for a unique tail", () => {
    expect(rankSearchHits("mdview/MdPanel.tsx", entries)).toEqual(["/repo/src/mdview/MdPanel.tsx"]);
  });

  it("returns nothing when no file matches", () => {
    expect(rankSearchHits("nope.ts", entries)).toEqual([]);
  });

  it("skips directories", () => {
    const withDir = [{ path: "/repo/src/main.ts", name: "main.ts", is_dir: true }];
    expect(rankSearchHits("main.ts", withDir)).toEqual([]);
  });
});
