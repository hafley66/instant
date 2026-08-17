export function boopHailArgs(
  lane: string,
  mailDir: string,
  body: string,
  from = "coordinator",
  kind = "dispatch",
): string[] {
  return [
    "beep", "hail", lane, "--mail-dir", mailDir,
    "--from", from, "--kind", kind, "--body", body,
  ];
}

export function boopAckArgs(lane: string, mailDir: string): string[] {
  return ["beep", "message", "ack", "--mail-dir", mailDir, "--lane", lane];
}

export function boopLaneListArgs(mailDir: string): string[] {
  return ["beep", "lane", "list", "--mail-dir", mailDir];
}

export function messageIdFromOutput(output: string): string | null {
  return output.match(/queued (m-[0-9a-f]+) ->/)?.[1] ?? null;
}

export function ackCountFromOutput(output: string): number {
  return Number(/acked (\d+)/.exec(output)?.[1] ?? 0);
}
