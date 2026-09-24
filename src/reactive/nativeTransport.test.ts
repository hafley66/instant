import { describe, it, expect } from "vitest";
import { deriveWsUrl } from "./nativeTransport";

describe("deriveWsUrl", () => {
  it("derives from the serving origin, honors ?ws=, and falls back to instant-serve's default", () => {
    const cases = {
      serveHttp: deriveWsUrl({ protocol: "http:", host: "127.0.0.1:47790", search: "" }, false),
      serveHttps: deriveWsUrl({ protocol: "https:", host: "box.example:8443", search: "" }, false),
      override: deriveWsUrl({ protocol: "http:", host: "127.0.0.1:47790", search: "?ws=ws://127.0.0.1:1/ws" }, false),
      emptyOverride: deriveWsUrl({ protocol: "http:", host: "127.0.0.1:47790", search: "?ws=" }, false),
      viteDev: deriveWsUrl({ protocol: "http:", host: "localhost:1420", search: "" }, true),
      viteDevOverride: deriveWsUrl({ protocol: "http:", host: "localhost:1420", search: "?ws=ws://x/ws" }, true),
      tauriScheme: deriveWsUrl({ protocol: "tauri:", host: "localhost", search: "" }, false),
      fileScheme: deriveWsUrl({ protocol: "file:", host: "", search: "" }, false),
      noLocation: deriveWsUrl(undefined, false),
    };
    expect(cases).toMatchInlineSnapshot(`
      {
        "emptyOverride": "ws://127.0.0.1:47790/ws",
        "fileScheme": "ws://127.0.0.1:47777/ws",
        "noLocation": "ws://127.0.0.1:47777/ws",
        "override": "ws://127.0.0.1:1/ws",
        "serveHttp": "ws://127.0.0.1:47790/ws",
        "serveHttps": "wss://box.example:8443/ws",
        "tauriScheme": "ws://127.0.0.1:47777/ws",
        "viteDev": "ws://127.0.0.1:47777/ws",
        "viteDevOverride": "ws://x/ws",
      }
    `);
  });
});
