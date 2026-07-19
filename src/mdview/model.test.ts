import { describe, it, expect } from "vitest";
import {
  parseMdSections,
  sliceOwn,
  slugify,
  expandChain,
  resolveMdLink,
  allSectionIds,
} from "./model";

const DOC = [
  "intro paragraph",
  "",
  "# Alpha",
  "alpha body",
  "## One",
  "one body",
  "```md",
  "## not a heading (inside fence)",
  "```",
  "### Deep",
  "deep body",
  "## Two",
  "two body",
  "# Beta",
  "beta body",
  "# Alpha",
  "second alpha",
].join("\n");

describe("slugify", () => {
  it("makes github-ish slugs", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
    expect(slugify("  Spaces   and_under ")).toBe("spaces-and_under".replace("_", "-"));
    expect(slugify("")).toBe("section");
  });
});

describe("parseMdSections", () => {
  const doc = parseMdSections(DOC);

  it("builds the heading tree by depth", () => {
    expect(doc.tree.map((s) => s.id)).toEqual(["alpha", "beta", "alpha-1"]);
    const alpha = doc.byId.get("alpha")!;
    expect(alpha.children.map((s) => s.id)).toEqual(["one", "two"]);
    expect(alpha.children[0].children.map((s) => s.id)).toEqual(["deep"]);
  });

  it("dedups repeated titles", () => {
    expect(doc.byId.get("alpha-1")!.title).toBe("Alpha");
  });

  it("skips headings inside fenced code", () => {
    expect(doc.byId.has("not-a-heading-inside-fence")).toBe(false);
    expect(doc.byId.get("one")!.children.length).toBe(1);
  });

  it("captures the preamble", () => {
    expect(doc.preamble.trim()).toBe("intro paragraph");
    expect(parseMdSections("# only a heading").preamble).toBe("");
  });

  it("slices each section's own body, excluding subsections", () => {
    expect(sliceOwn(DOC, doc.byId.get("alpha")!).trim()).toBe("alpha body");
    expect(sliceOwn(DOC, doc.byId.get("one")!)).toContain("one body");
    expect(sliceOwn(DOC, doc.byId.get("one")!)).toContain("## not a heading (inside fence)");
    expect(sliceOwn(DOC, doc.byId.get("one")!)).not.toContain("deep body");
    expect(sliceOwn(DOC, doc.byId.get("two")!).trim()).toBe("two body");
  });

  it("ends sections at the next same-or-shallower heading / EOF", () => {
    expect(sliceOwn(DOC, doc.byId.get("alpha-1")!).trim()).toBe("second alpha");
    expect(sliceOwn(DOC, doc.byId.get("deep")!).trim()).toBe("deep body");
  });

  it("collects all ids", () => {
    expect([...allSectionIds(doc)].sort()).toEqual(
      ["alpha", "alpha-1", "beta", "deep", "one", "two"].sort(),
    );
  });

  it("handles setext headings", () => {
    // NB: a setext underline binds to the paragraph directly above it, so the
    // blank lines matter — "body\nSub\n---" would make one "body Sub" heading.
    const d = parseMdSections("Title\n=====\n\nbody\n\nSub\n---\n\nsub body");
    expect(d.tree.map((s) => s.id)).toEqual(["title"]);
    expect(d.tree[0].children.map((s) => s.id)).toEqual(["sub"]);
  });
});

describe("expandChain", () => {
  const doc = parseMdSections(DOC);
  it("returns the ancestor chain inclusive", () => {
    expect(expandChain(doc, "deep")).toEqual(["alpha", "one", "deep"]);
    expect(expandChain(doc, "beta")).toEqual(["beta"]);
    expect(expandChain(doc, "missing")).toEqual([]);
  });
});

describe("resolveMdLink", () => {
  const cur = "/repo/docs/guide/intro.md";
  it("resolves relative md links against the file's dir", () => {
    expect(resolveMdLink(cur, "setup.md")).toEqual({ path: "/repo/docs/guide/setup.md", frag: undefined });
    expect(resolveMdLink(cur, "../README.md#install")).toEqual({ path: "/repo/docs/README.md", frag: "install" });
    expect(resolveMdLink(cur, "./a/b.md")).toEqual({ path: "/repo/docs/guide/a/b.md", frag: undefined });
  });
  it("passes absolute paths through", () => {
    expect(resolveMdLink(cur, "/etc/notes.md")).toEqual({ path: "/etc/notes.md", frag: undefined });
  });
  it("rejects non-md and remote links", () => {
    expect(resolveMdLink(cur, "image.png")).toBeNull();
    expect(resolveMdLink(cur, "https://x.com/a.md")).toBeNull();
    expect(resolveMdLink(cur, "#anchor")).toBeNull();
  });
});
