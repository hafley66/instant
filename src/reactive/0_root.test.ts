import { Subject, finalize, throwError, type Subscription } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { root, sink, startRoot } from "./0_root";

describe("root", () => {
  const until = new Subject<void>();
  const log: string[] = [];
  let running: Subscription;

  beforeEach(() => {
    log.length = 0;
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation((...args) => void log.push(`console.error ${args.join(" ")}`));
    running = startRoot(until);
  });
  afterEach(() => {
    running.unsubscribe();
    vi.useRealTimers();
  });

  it("runs every pushed flow, isolates a failing one, and ends them together", () => {
    const a = new Subject<string>();
    const b = new Subject<string>();
    root.next(a.pipe(sink((value) => log.push(`a ${value}`)), finalize(() => log.push("a ended"))));
    root.next(throwError(() => new Error("boom")));
    root.next(b.pipe(sink((value) => log.push(`b ${value}`)), finalize(() => log.push("b ended"))));
    a.next("1");
    b.next("1");
    until.next();
    a.next("2");

    expect(log).toMatchInlineSnapshot(`
      [
        "console.error root flow: Error: boom",
        "a 1",
        "b 1",
        "a ended",
        "b ended",
      ]
    `);
  });

  it("keeps a flow alive after its effect throws and re-raises the throw later", () => {
    const source = new Subject<number>();
    root.next(source.pipe(sink((value) => {
      if (value === 2) throw new Error("bad 2");
      log.push(`saw ${value}`);
    })));
    source.next(1);
    source.next(2);
    source.next(3);

    expect(log).toMatchInlineSnapshot(`
      [
        "saw 1",
        "saw 3",
      ]
    `);
    expect(() => vi.runAllTimers()).toThrowErrorMatchingInlineSnapshot(`[Error: bad 2]`);
  });
});
