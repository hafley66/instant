import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { casUpdateJson, CorruptJsonError } from "./0_atomicJson";

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "atomic-"));
  return { dir, path: join(dir, "registry.json") };
}

describe("casUpdateJson", () => {
  it("writes a key when the file is missing and leaves no tmp file", () => {
    const { dir, path } = scratch();
    const out = casUpdateJson(path, (current) => ({ ...current, a: 1 }));
    expect(out.a).toBe(1);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ a: 1 });
    expect(readdirSync(dir).filter((n) => n.includes(".tmp-"))).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("merges a concurrent writer via CAS retry", () => {
    const { dir, path } = scratch();
    let bDone = false;
    const out = casUpdateJson(
      path,
      (current) => ({ ...current, a: 1 }),
      {
        afterRead: () => {
          if (bDone) return;
          bDone = true;
          casUpdateJson(path, (cur) => ({ ...cur, b: 2 }));
        },
      },
    );
    const final = JSON.parse(readFileSync(path, "utf8"));
    expect(final).toEqual({ a: 1, b: 2 });
    expect(out).toEqual({ a: 1, b: 2 });
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws CorruptJsonError on invalid JSON and leaves the file untouched", () => {
    const { dir, path } = scratch();
    writeFileSync(path, "not json");
    expect(() => casUpdateJson(path, (current) => current)).toThrow(CorruptJsonError);
    expect(readFileSync(path, "utf8")).toBe("not json");
    rmSync(dir, { recursive: true, force: true });
  });

  it("gives up after the retry budget is exhausted", () => {
    const { dir, path } = scratch();
    let n = 0;
    writeFileSync(path, "{}");
    expect(() =>
      casUpdateJson(
        path,
        (current) => ({ ...current, a: 1 }),
        {
          retries: 2,
          afterRead: () => {
            writeFileSync(path, JSON.stringify({ n: n++ }));
          },
        },
      ),
    ).toThrow(/gave up/);
    rmSync(dir, { recursive: true, force: true });
  });
});
