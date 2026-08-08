import { describe, expect, it } from "vitest";
import { panelApiVisibility$, type VisiblePanelApi } from "./0_panelVisibility";

describe("panel visibility", () => {
  it("emits initial and changed visibility once, then disposes the dock listener", () => {
    let listener: ((event: { isVisible: boolean }) => void) | undefined;
    let disposed = 0;
    const panel: VisiblePanelApi = {
      isVisible: true,
      onDidVisibilityChange(next) {
        listener = next;
        return { dispose: () => disposed++ };
      },
    };
    const values: boolean[] = [];
    const subscription = panelApiVisibility$(panel).subscribe((visible) => values.push(visible));
    listener?.({ isVisible: true });
    listener?.({ isVisible: false });
    listener?.({ isVisible: false });
    listener?.({ isVisible: true });
    subscription.unsubscribe();

    expect({ values, disposed }).toMatchInlineSnapshot(`
      {
        "disposed": 1,
        "values": [
          true,
          false,
          true,
        ],
      }
    `);
  });

  it("reports a missing panel as hidden and complete", () => {
    const events: string[] = [];
    panelApiVisibility$(null).subscribe({
      next: (visible) => events.push(`visible:${visible}`),
      complete: () => events.push("complete"),
    });
    expect(events).toMatchInlineSnapshot(`
      [
        "visible:false",
        "complete",
      ]
    `);
  });
});
