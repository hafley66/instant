import { beforeEach, describe, expect, it, vi } from "vitest";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("addEventListener", vi.fn());
});

describe("sprefa root storage signal", () => {
  it("uses the legacy fallback and persists raw string values", async () => {
    vi.resetModules();
    const { createSprefaRoot } = await import("./statusModel");
    const storage = new MemoryStorage();
    const root = createSprefaRoot(storage);
    expect(root.$()).toBe("~/projects/sprefa/v5");
    root.$("/tmp/sprefa");
    expect(storage.getItem("sprefa.root")).toBe("/tmp/sprefa");
  });

  it("reads an existing legacy raw value", async () => {
    vi.resetModules();
    const { createSprefaRoot } = await import("./statusModel");
    const storage = new MemoryStorage();
    storage.setItem("sprefa.root", "/existing");
    expect(createSprefaRoot(storage).$()).toBe("/existing");
  });
});

