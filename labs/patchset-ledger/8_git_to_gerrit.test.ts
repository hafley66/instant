import { describe, expect, it } from "vitest";
import {
  buildDiffInfo,
  contentGroups,
  gitToGerritDiff,
  makeTranslationRepo,
  myersDiff,
  parseNameStatus,
  splitLines,
} from "./7_git_to_gerrit";

describe("line splitting", () => {
  it("splits a body into trailing-newline-free lines", () => {
    expect(splitLines("one\ntwo\n")).toEqual(["one", "two"]);
    expect(splitLines("")).toEqual([]);
    expect(splitLines("single")).toEqual(["single"]);
  });

  it("normalizes CRLF", () => {
    expect(splitLines("a\r\nb\r\n")).toEqual(["a", "b"]);
  });
});

describe("edit script", () => {
  it("emits same for identical bodies", () => {
    expect(myersDiff(["a", "b"], ["a", "b"])).toEqual([
      { kind: "same", line: "a" },
      { kind: "same", line: "b" },
    ]);
  });

  it("emits del then ins for a full replacement", () => {
    expect(myersDiff(["x"], ["y"])).toEqual([{ kind: "del", line: "x" }, { kind: "ins", line: "y" }]);
  });
});

describe("content grouping", () => {
  it("groups unchanged runs as ab and changes as a/b", () => {
    const ops = myersDiff(["one", "TWO", "three"], ["one", "two", "three", "four"]);
    const groups = contentGroups(ops);
    expect(groups).toEqual([
      { ab: ["one"] },
      { a: ["TWO"], b: ["two"] },
      { ab: ["three"] },
      { b: ["four"] },
    ]);
  });
});

describe("buildDiffInfo", () => {
  it("builds a MODIFIED file with meta on both sides", () => {
    const info = buildDiffInfo({
      path: "base.txt",
      changeType: "MODIFIED",
      aText: "one\ntwo\nthree\n",
      bText: "one\nTWO\nthree\nfour\n",
    });
    expect(info.change_type).toBe("MODIFIED");
    expect(info.intraline_status).toBe("OK");
    expect(info.meta_a).toEqual({ name: "base.txt", content_type: "text/plain", lines: 3 });
    expect(info.meta_b).toEqual({ name: "base.txt", content_type: "text/plain", lines: 4 });
    expect(info.content).toEqual([
      { ab: ["one"] },
      { a: ["two"], b: ["TWO"] },
      { ab: ["three"] },
      { b: ["four"] },
    ]);
  });

  it("builds an ADDED file without meta_a", () => {
    const info = buildDiffInfo({ path: "a.txt", changeType: "ADDED", bText: "a\nb\n" });
    expect(info.meta_a).toBeUndefined();
    expect(info.meta_b).toEqual({ name: "a.txt", content_type: "text/plain", lines: 2 });
    expect(info.content).toEqual([{ b: ["a", "b"] }]);
  });

  it("builds a DELETED file without meta_b", () => {
    const info = buildDiffInfo({ path: "gone.txt", changeType: "DELETED", aText: "a\nb\n" });
    expect(info.meta_b).toBeUndefined();
    expect(info.content).toEqual([{ a: ["a", "b"] }]);
  });

  it("sets binary true when a body contains a NUL", () => {
    const info = buildDiffInfo({ path: "img.png", changeType: "ADDED", bText: "PNG\x00data" });
    expect(info.binary).toBe(true);
    expect(info.meta_b?.content_type).toBe("application/octet-stream");
  });

  it("is deterministic across repeated calls", () => {
    const one = buildDiffInfo({ path: "f.ts", changeType: "MODIFIED", aText: "a\nb\n", bText: "a\nc\n" });
    const two = buildDiffInfo({ path: "f.ts", changeType: "MODIFIED", aText: "a\nb\n", bText: "a\nc\n" });
    expect(one).toEqual(two);
  });
});

describe("parseNameStatus", () => {
  it("parses raw multi-line output", () => {
    const out = "M\tbase.txt\nA\tadded.txt\nD\tgone.txt\n";
    expect(parseNameStatus(out)).toEqual([
      { path: "base.txt", type: "MODIFIED" },
      { path: "added.txt", type: "ADDED" },
      { path: "gone.txt", type: "DELETED" },
    ]);
  });

  it("parses -z output", () => {
    const out = "M\0base.txt\0A\0added.txt\0";
    expect(parseNameStatus(out)).toEqual([
      { path: "base.txt", type: "MODIFIED" },
      { path: "added.txt", type: "ADDED" },
    ]);
  });

  it("parses a rename with source path", () => {
    const out = "R100\told.txt\tnew.txt\n";
    expect(parseNameStatus(out)).toEqual([{ path: "new.txt", type: "RENAMED", fromPath: "old.txt" }]);
  });
});

describe("git-to-gerrit seam", () => {
  it("maps real git output onto DiffInfo per file", () => {
    const { repo, from, to } = makeTranslationRepo();
    const files = gitToGerritDiff(repo, from, to);
    expect(files.map((f) => [f.path, f.type])).toEqual([
      ["added.txt", "ADDED"],
      ["base.txt", "MODIFIED"],
    ]);
    const base = files.find((f) => f.path === "base.txt")!;
    expect(base.info.meta_a?.lines).toBe(3);
    expect(base.info.meta_b?.lines).toBe(4);
    expect(base.info.content).toContainEqual({ a: ["two"], b: ["TWO"] });
  });
});
