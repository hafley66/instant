import { describe, expect, it } from "vitest";
import { paths } from "./api";

describe("generated activity HTTP contracts", () => {
  it("builds the authoritative config request", () => {
    expect(paths.activityConfig.endpoint.request(undefined)).toEqual({
      url: "http://127.0.0.1:8787/config",
      method: "GET",
    });
  });

  it("builds a typed ingest request", () => {
    const event: paths.activityIngest.Input = {
      type: "editor",
      event: "save",
      path: "/tmp/a.ts",
      ts: 42,
    };
    expect(paths.activityIngest.endpoint.request(event)).toEqual({
      url: "http://127.0.0.1:8787/ingest",
      method: "POST",
      body: event,
    });
  });
});
