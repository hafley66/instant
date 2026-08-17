import { describe, expect, it } from "vitest";
import { ackCountFromOutput, boopAckArgs, boopHailArgs, boopLaneListArgs, messageIdFromOutput } from "./0_livespawnBoop";

describe("livespawn Boop boundary", () => {
  it("builds hail, ack, and list argv", () => {
    expect(boopHailArgs("gate-7", "/tmp/mail", "run the probe")).toMatchInlineSnapshot(`
      [
        "beep",
        "hail",
        "gate-7",
        "--mail-dir",
        "/tmp/mail",
        "--from",
        "coordinator",
        "--kind",
        "dispatch",
        "--body",
        "run the probe",
      ]
    `);
    expect(boopAckArgs("gate-7", "/tmp/mail")).toMatchInlineSnapshot(`
      [
        "beep",
        "message",
        "ack",
        "--mail-dir",
        "/tmp/mail",
        "--lane",
        "gate-7",
      ]
    `);
    expect(boopLaneListArgs("/tmp/mail")).toEqual(["beep", "lane", "list", "--mail-dir", "/tmp/mail"]);
  });

  it("parses Boop's queued message id and ack count", () => {
    expect(messageIdFromOutput("queued m-c4c55a88 -> gate-7\nno registry route")).toBe("m-c4c55a88");
    expect(messageIdFromOutput("swept 1 unacked, acked 0, expired 0")).toBeNull();
    expect(ackCountFromOutput("swept 3 unacked, acked 2, expired 0")).toBe(2);
    expect(ackCountFromOutput("swept 1 unacked, acked 0, expired 0")).toBe(0);
  });
});
