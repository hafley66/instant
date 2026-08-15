/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Signal } from "@hafley66/signals";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const count = Signal(0);

function PlainSignalReader() {
  return <output data-testid="count">{count.$()}</output>;
}

describe("signals JSX integration", () => {
  afterEach(() => count.$(0));

  it("tracks a plain component .$() read without a React subscription wrapper", async () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(<PlainSignalReader />));
    expect(host.innerHTML).toMatchInlineSnapshot(`"<output data-testid=\"count\">0</output>"`);

    await act(async () => count.$(7));
    expect(host.innerHTML).toMatchInlineSnapshot(`"<output data-testid=\"count\">7</output>"`);

    await act(async () => root.unmount());
  });
});
