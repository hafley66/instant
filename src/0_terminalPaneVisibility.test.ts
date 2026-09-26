// @vitest-environment jsdom
import { Terminal } from "@xterm/xterm";
import { createBoopXtermPane, type BoopXtermPorts, type HarnessId } from "@hafley66/boop-xterm";
import { Endpoint, Signal, type Serializable } from "@hafley66/signals";
import { of } from "rxjs";
import { describe, expect, it, vi } from "vitest";

function ports() {
  const endpoint = <I, O>(url: string) => new Endpoint<I, O>({
    request: (input) => ({ url, method: "POST", body: input as Serializable }),
    decode: (response) => response.body as O,
  }, (request) => of({ status: 200, body: request.url === "boop_mux_session" ? null : [] }));
  const paneVisible = Signal(true);
  const paneClosed = Signal(false);
  const value: BoopXtermPorts = {
    boop_mux_session: endpoint("boop_mux_session"),
    boop_mux_capture: endpoint("boop_mux_capture"),
    boop_turns: endpoint("boop_turns"),
    boop_turns_recent: endpoint("boop_turns_recent"),
    boop_sync_session: endpoint("boop_sync_session"),
    boop_locate_turns: endpoint("boop_locate_turns"),
    scroll_session: endpoint("scroll_session"),
    paneVisible,
    paneClosed,
    harness: Signal<HarnessId | null>(null),
    clipboardEnabled: Signal(false),
    tabSessionIds: Signal<string[]>([]),
    scanRequested: Signal<void>(),
    selectionClear: Signal<void>(),
  };
  return { ...value, paneVisible, paneClosed };
}

function write(term: Terminal, text: string): Promise<void> {
  return new Promise((resolve) => term.write(text, resolve));
}

async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("anchor projection timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("terminal pane visibility", () => {
  it("re-projects visible anchors when a hidden pane activates", async () => {
    vi.stubGlobal("matchMedia", (media: string) => ({
      matches: false, media, onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return true; },
    }));
    const host = document.createElement("div");
    host.style.cssText = "position:relative;width:800px;height:400px";
    document.body.appendChild(host);
    const term = new Terminal({ cols: 80, rows: 20, allowProposedApi: true });
    term.open(host);
    const input = ports();
    const pane = createBoopXtermPane(term, host, { id: "pane", target: "pane", socket: null }, input);
    const subscription = pane.effects.subscribe();
    try {
      await write(term, "before hide");
      await until(() => pane.anchors.state.visible.$().some((line) => line.text.includes("before hide")));
      input.paneVisible.$(false);
      await write(term, " after activation");
      await until(() => pane.viewport.snapshot.visible.$() === false);
      const hiddenAnchors = pane.anchors.state.$();
      input.paneVisible.$(true);
      await until(() => pane.viewport.snapshot.visible.$() && pane.anchors.state.$() !== hiddenAnchors);
      expect(pane.anchors.state.visible.$().map((line) => line.text)).toContain("before hide after activation");
    } finally {
      input.paneClosed.$(true);
      subscription.unsubscribe();
      term.dispose();
      host.remove();
    }
  });
});
