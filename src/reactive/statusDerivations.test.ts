import { describe, expect, it } from "vitest";
import { aggregateStatus } from "./statusDerivations";
import type { StatusRow } from "./statusModel";

const row = (id: string, state: StatusRow["report"]["state"]): StatusRow => ({
  id,
  label: id,
  report: { state },
});

describe("aggregateStatus", () => {
  it("is unknown with no probes", () => expect(aggregateStatus([])).toBe("unknown"));
  it("selects the worst mixed health", () => {
    expect(aggregateStatus([row("up", "up"), row("idle", "idle"), row("down", "down")])).toBe("down");
    expect(aggregateStatus([row("up", "up"), row("degraded", "degraded")])).toBe("degraded");
  });
});

