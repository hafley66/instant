import { describe, it, expect } from "vitest";
import { camel, createClient, type Call, type RpcTransport } from "./client";

type TestContract = {
  resolve_ref: Call<{ token: string; cwd: string }, { kind: "miss" }>;
  clear_ref_index: Call<void, void>;
};

const recorder = () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const transport: RpcTransport = {
    request: async <T,>(method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return { kind: "miss" } as T;
    },
  };
  return { calls, transport };
};

describe("createClient", () => {
  it("exposes one camelCase method per contract entry", () => {
    const { transport } = recorder();
    const client = createClient<TestContract>(["resolve_ref", "clear_ref_index"], transport);
    expect(Object.keys(client).sort()).toEqual(["clearRefIndex", "resolveRef"]);
  });

  it("sends the method name and params the caller passed", async () => {
    const { calls, transport } = recorder();
    const client = createClient<TestContract>(["resolve_ref", "clear_ref_index"], transport);
    await client.resolveRef({ token: "src/main.ts", cwd: "/repo" });
    expect(calls).toEqual([
      { method: "resolve_ref", params: { token: "src/main.ts", cwd: "/repo" } },
    ]);
  });

  it("sends an empty object for a call that takes nothing", async () => {
    const { calls, transport } = recorder();
    const client = createClient<TestContract>(["clear_ref_index"], transport);
    await client.clearRefIndex();
    expect(calls).toEqual([{ method: "clear_ref_index", params: {} }]);
  });

  it("passes a rejection through to the caller", async () => {
    const transport: RpcTransport = { request: () => Promise.reject(new Error("no shell")) };
    const client = createClient<TestContract>(["resolve_ref"], transport);
    await expect(client.resolveRef({ token: "x", cwd: "/" })).rejects.toThrow("no shell");
  });
});

describe("camel", () => {
  it("converts snake_case command names", () => {
    expect(camel("resolve_ref")).toBe("resolveRef");
    expect(camel("boop_mux_send_keys")).toBe("boopMuxSendKeys");
    expect(camel("screenshot")).toBe("screenshot");
  });
});
