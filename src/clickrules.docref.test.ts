// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ resolve: [] as unknown[][], open: [] as unknown[][] }));

vi.mock("./refResolve", () => ({
  resolveRef: async (...args: unknown[]) => {
    calls.resolve.push(args);
    return { kind: "hit", ref: { path: "/repo/crates/scm/src/lang/rust/2_call.rs", line: 790, source: "search" } };
  },
}));
vi.mock("./preview", () => ({
  openPathInInstant: async (...args: unknown[]) => {
    calls.open.push(args);
  },
  openPreviewPanel: () => undefined,
  previewOrigin: new Map(),
}));
vi.mock("./terminal", () => ({ getFocusedTermId: () => null, tabMetaById: () => undefined }));
vi.mock("./reactdock", () => ({ addPreviewPanel: () => undefined }));
vi.mock("./refChoicesPanel", () => ({ RefChoicesPanel: () => null }));

const { openDocumentRef } = await import("./clickrules");

// ⌘-click on inline code in a rendered markdown file: the token resolves from
// the document (boop's resolve_ref `doc`), searched from the document's folder.
describe("openDocumentRef", () => {
  beforeEach(() => {
    calls.resolve.length = 0;
    calls.open.length = 0;
  });
  it("hands the token and the document path to the resolver and opens the hit at its line", async () => {
    await openDocumentRef("2_call.rs:790-801", "/repo/docs/plans/notes.md");
    expect(calls).toEqual({
      resolve: [["2_call.rs:790-801", "/repo/docs/plans", [], undefined, "/repo/docs/plans/notes.md"]],
      open: [["/repo/crates/scm/src/lang/rust/2_call.rs", 790]],
    });
  });
});
