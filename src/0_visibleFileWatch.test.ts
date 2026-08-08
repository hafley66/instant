import { Subject } from "rxjs";
import { describe, expect, it } from "vitest";
import { visibleFileWatch$ } from "./0_visibleFileWatch";

describe("visible file watch", () => {
  it("claims only while visible and replaces an in-flight claim after a hide", async () => {
    const visibility = new Subject<boolean>();
    const claims: Array<(release: () => void) => void> = [];
    const released: number[] = [];
    const watch = visibleFileWatch$(visibility, () => new Promise((resolve) => claims.push(resolve))).subscribe();

    visibility.next(true);
    visibility.next(false);
    visibility.next(true);
    claims[0](() => released.push(1));
    await Promise.resolve();
    claims[1](() => released.push(2));
    await Promise.resolve();
    visibility.next(false);
    watch.unsubscribe();

    expect({ claimCount: claims.length, released }).toMatchInlineSnapshot(`
      {
        "claimCount": 2,
        "released": [
          1,
          2,
        ],
      }
    `);
  });
});
