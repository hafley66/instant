import { describe, it, expect } from "vitest";
import {
  ancestorsOf,
  crawlCandidates,
  withDirectories,
  fuzzyPathHits,
  uniqueDirNamed,
  type IndexEntry,
} from "./0_pathLadder";

const file = (path: string): IndexEntry => ({
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
  is_dir: false,
});

const HOME = "/Users/me";
const REPO = `${HOME}/projects/instant`;

describe("ancestorsOf", () => {
  it("walks from the cwd up to the boundary, nearest first", () => {
    expect(ancestorsOf(`${REPO}/src/mdview`, HOME)).toEqual([
      `${REPO}/src/mdview`,
      `${REPO}/src`,
      REPO,
      `${HOME}/projects`,
      HOME,
    ]);
  });

  it("stops at the cap", () => {
    expect(ancestorsOf(`${REPO}/src/mdview`, HOME, 2)).toEqual([`${REPO}/src/mdview`, `${REPO}/src`]);
  });

  it("walks toward the root when the cwd is outside the boundary", () => {
    expect(ancestorsOf("/tmp/term-e2e/src", HOME)).toEqual(["/tmp/term-e2e/src", "/tmp/term-e2e", "/tmp"]);
  });

  it("returns nothing for the root itself", () => {
    expect(ancestorsOf("/", HOME)).toEqual([]);
  });
});

describe("crawlCandidates", () => {
  it("tries cwd, repo root, then each ancestor", () => {
    expect(crawlCandidates("notes.md", `${REPO}/src`, REPO, HOME)).toEqual([
      { path: `${REPO}/src/notes.md`, step: "cwd" },
      { path: `${REPO}/notes.md`, step: "repo" },
      { path: `${HOME}/projects/notes.md`, step: "ancestor" },
      { path: `${HOME}/notes.md`, step: "ancestor" },
    ]);
  });

  it("reaches a sibling repo through the ancestor rung", () => {
    const paths = crawlCandidates("instant-lanes/README.md", `${REPO}/src`, REPO, HOME).map((c) => c.path);
    expect(paths).toContain(`${HOME}/projects/instant-lanes/README.md`);
  });

  it("leaves an absolute or home path alone", () => {
    expect(crawlCandidates("/a/b.ts", `${REPO}/src`, REPO, HOME)).toEqual([{ path: "/a/b.ts", step: "absolute" }]);
    expect(crawlCandidates("~/b.ts", `${REPO}/src`, REPO, HOME)).toEqual([{ path: "~/b.ts", step: "absolute" }]);
  });

  it("drops the ./ prefix and never emits a candidate twice", () => {
    const candidates = crawlCandidates("./main.ts", REPO, REPO, HOME);
    expect(candidates[0]).toEqual({ path: `${REPO}/main.ts`, step: "cwd" });
    expect(new Set(candidates.map((c) => c.path)).size).toBe(candidates.length);
  });
});

describe("withDirectories", () => {
  const index = withDirectories([file(`${REPO}/src/mdview/MdPanel.tsx`), file(`${REPO}/e2e/term.tsx`)], REPO);

  it("folds in every directory between the root and a file", () => {
    expect(index.filter((e) => e.is_dir).map((e) => e.path).sort()).toEqual([
      `${REPO}/e2e`,
      `${REPO}/src`,
      `${REPO}/src/mdview`,
    ]);
  });

  it("keeps the files it was given", () => {
    expect(index.filter((e) => !e.is_dir)).toHaveLength(2);
  });
});

describe("fuzzyPathHits", () => {
  const entries = withDirectories(
    [
      file(`${REPO}/src/mdview/MdPanel.tsx`),
      file(`${REPO}/src/main.ts`),
      file(`${REPO}/src/preview.ts`),
      file(`${REPO}/src/refResolve.ts`),
      file(`${REPO}/e2e/notes/other.ts`),
      file(`${REPO}/packages/patchset-diff/src/index.ts`),
    ],
    REPO,
  );

  it("finds a file from an abbreviated basename", () => {
    expect(fuzzyPathHits("mdpanel", entries)[0].path).toBe(`${REPO}/src/mdview/MdPanel.tsx`);
  });

  it("finds a file from a partial path", () => {
    expect(fuzzyPathHits("mdview/MdPanel", entries)[0].path).toBe(`${REPO}/src/mdview/MdPanel.tsx`);
  });

  it("finds a directory, not only files", () => {
    const hit = fuzzyPathHits("patchset-diff", entries)[0];
    expect(hit.path).toBe(`${REPO}/packages/patchset-diff`);
    expect(hit.is_dir).toBe(true);
  });

  it("returns nothing for a token that names no file", () => {
    expect(fuzzyPathHits("nope.ts", entries)).toEqual([]);
    expect(fuzzyPathHits("qqqqzz", entries)).toEqual([]);
  });

  it("refuses queries too short to discriminate", () => {
    expect(fuzzyPathHits(".ts", entries)).toEqual([]);
  });

  it("honours the limit", () => {
    expect(fuzzyPathHits("src", entries, 2).length).toBeLessThanOrEqual(2);
  });
});

describe("uniqueDirNamed", () => {
  const entries = withDirectories(
    [file(`${REPO}/src/mdview/MdPanel.tsx`), file(`${REPO}/e2e/mdview/copy.tsx`), file(`${REPO}/labs/one.ts`)],
    REPO,
  );

  it("resolves a folder name that occurs once", () => {
    expect(uniqueDirNamed("labs", entries)).toBe(`${REPO}/labs`);
  });

  it("refuses an ambiguous folder name", () => {
    expect(uniqueDirNamed("mdview", entries)).toBeNull();
  });

  it("refuses a short word and a non-folder", () => {
    expect(uniqueDirNamed("e2e", entries)).toBeNull();
    expect(uniqueDirNamed("MdPanel.tsx", entries)).toBeNull();
  });
});
