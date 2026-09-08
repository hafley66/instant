import { describe, it, expect, vi, afterEach } from "vitest";
import { wsTransport } from "./wsTransport";
import type { NativeTransport } from "./nativeTransport";

// Minimal browser WebSocket stand-in: constants and handler slots the
// transport assigns, plus test handles to drive open/message/close by hand.
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.shut();
  }
  shut(): void {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  reply(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  raw(text: string): void {
    this.onmessage?.({ data: text });
  }
}

// The socket dials lazily on the first send, so every test performs its first
// invoke/listen BEFORE sock().open() has a socket to open.
function harness(url = "ws://test.local"): {
  transport: NativeTransport;
  sockets: FakeSocket[];
  sock: () => FakeSocket;
} {
  const sockets: FakeSocket[] = [];
  const transport = wsTransport(url, (u) => {
    const s = new FakeSocket(u);
    sockets.push(s);
    return s as unknown as WebSocket;
  });
  return { transport, sockets, sock: () => sockets[sockets.length - 1]! };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("wsTransport", () => {
  it("sends a jsonrpc 2.0 request and resolves the matching result", async () => {
    const { transport, sock } = harness();
    const call = transport.invoke<string>("read_text", { path: "/a" });
    sock().open();
    expect(sock().sent).toHaveLength(1);
    expect(JSON.parse(sock().sent[0]!)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "read_text",
      params: { path: "/a" },
    });
    sock().reply({ jsonrpc: "2.0", id: 1, result: "body" });
    await expect(call).resolves.toBe("body");
  });

  it("rejects with Error(error.message) on an error response", async () => {
    const { transport, sock } = harness();
    const call = transport.invoke("nope");
    sock().open();
    expect(JSON.parse(sock().sent[0]!).params).toEqual({});
    sock().reply({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "no such command" } });
    await expect(call).rejects.toThrow("no such command");
  });

  it("routes two in-flight ids to their own results", async () => {
    const { transport, sock } = harness();
    const a = transport.invoke<number>("cmd_a");
    const b = transport.invoke<number>("cmd_b");
    sock().open();
    expect(sock().sent.map((f) => JSON.parse(f).id)).toEqual([1, 2]);
    sock().reply({ jsonrpc: "2.0", id: 2, result: 22 });
    sock().reply({ jsonrpc: "2.0", id: 1, result: 11 });
    await expect(a).resolves.toBe(11);
    await expect(b).resolves.toBe(22);
  });

  it("dispatches events notifications to callbacks by event name", async () => {
    const { transport, sock } = harness();
    const gotA: unknown[] = [];
    const gotB: unknown[] = [];
    await transport.listen("a", (p) => gotA.push(p));
    await transport.listen("b", (p) => gotB.push(p));
    sock().open();
    expect(sock().sent).toHaveLength(1); // one subscription, not two
    expect(JSON.parse(sock().sent[0]!).method).toBe("events");
    sock().reply({ jsonrpc: "2.0", method: "events", params: { event: "a", payload: 1 } });
    sock().reply({ jsonrpc: "2.0", method: "events", params: { event: "b", payload: "x" } });
    sock().reply({ jsonrpc: "2.0", method: "events", params: { event: "c", payload: 9 } });
    expect(gotA).toEqual([1]);
    expect(gotB).toEqual(["x"]);
  });

  it("stops dispatch after unlisten", async () => {
    const { transport, sock } = harness();
    const got: unknown[] = [];
    const unlisten = await transport.listen("a", (p) => got.push(p));
    sock().open();
    sock().reply({ jsonrpc: "2.0", method: "events", params: { event: "a", payload: 1 } });
    unlisten();
    sock().reply({ jsonrpc: "2.0", method: "events", params: { event: "a", payload: 2 } });
    expect(got).toEqual([1]);
  });

  it("queues calls made while closed and flushes them on open", async () => {
    const { transport, sock } = harness();
    const call = transport.invoke("queued");
    expect(sock().sent).toEqual([]);
    sock().open();
    expect(sock().sent).toHaveLength(1);
    sock().reply({ jsonrpc: "2.0", id: 1, result: "flushed" });
    await expect(call).resolves.toBe("flushed");
  });

  it("reconnects with doubling backoff and re-subscribes events", async () => {
    vi.useFakeTimers();
    const { transport, sockets, sock } = harness();
    const got: unknown[] = [];
    await transport.listen("evt", (p) => got.push(p));
    sock().open();
    expect(sock().sent).toHaveLength(1); // the events subscription
    sock().shut();
    await vi.advanceTimersByTimeAsync(249);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2); // first retry after 250ms
    sock().shut(); // this dial fails without opening, so the backoff doubles
    await vi.advanceTimersByTimeAsync(499);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3); // second retry after 500ms
    sock().open();
    expect(JSON.parse(sock().sent[0]!).method).toBe("events");
    sock().reply({ jsonrpc: "2.0", method: "events", params: { event: "evt", payload: 7 } });
    expect(got).toEqual([7]);
  });

  it("ignores a malformed frame and keeps serving later frames", async () => {
    const { transport, sock } = harness();
    const call = transport.invoke("after-garbage");
    sock().open();
    expect(() => sock().raw("not json at all")).not.toThrow();
    expect(() => sock().raw('"a bare string"')).not.toThrow();
    sock().reply({ jsonrpc: "2.0", id: 1, result: "still alive" });
    await expect(call).resolves.toBe("still alive");
  });

  it("ignores a response whose id is unknown", async () => {
    const { transport, sock } = harness();
    const call = transport.invoke("mine");
    sock().open();
    sock().reply({ jsonrpc: "2.0", id: 4242, result: null });
    expect(sock().sent).toHaveLength(1); // no retry, no crash
    sock().reply({ jsonrpc: "2.0", id: 1, result: "mine" });
    await expect(call).resolves.toBe("mine");
  });

  it("rejects pending calls when the socket closes", async () => {
    vi.useFakeTimers();
    const { transport, sock } = harness();
    const call = transport.invoke("never-answered");
    sock().open();
    sock().shut();
    await expect(call).rejects.toThrow(/ws transport closed/);
  });
});
