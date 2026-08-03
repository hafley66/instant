import { expect, test } from "@playwright/test";

// MailPreview over a fixture mailbox: four rows for lane-a, one of them acked
// by an APPENDED ack row (2026-08-03 bus ruling: latest row per id wins, ack is
// never an in-place edit), one reply threaded under its request, and one
// message for another agent that must not appear.
const mailDir = "~/.agent/mail";

const line = (row: Record<string, unknown>) => JSON.stringify(row);
const envelopes = [
  line({
    id: "m-1", from: "coordinator", to: "lane-a",
    from_timestamp: "2026-08-03T10:00:00Z", to_timestamp: null,
    kind: "request", reply_to: null, body: "read CONTRACT.md and report", ref: null,
  }),
  line({
    id: "m-2", from: "lane-a", to: "coordinator",
    from_timestamp: "2026-08-03T10:30:00Z", to_timestamp: null,
    kind: "result", reply_to: "m-1", body: "contract read, starting the store", ref: null,
  }),
  line({
    id: "m-3", from: "coordinator", to: "lane-b",
    from_timestamp: "2026-08-03T10:40:00Z", to_timestamp: null,
    kind: "note", reply_to: null, body: "not lane-a's mail", ref: null,
  }),
  line({
    id: "m-4", from: "coordinator", to: "lane-a",
    from_timestamp: "2026-08-03T11:00:00Z", to_timestamp: null,
    kind: "note", reply_to: null, body: "the ack sweep runs on demand, no daemon", ref: null,
  }),
  // The ack row: same id, to_timestamp filled by a cass hit in lane-a's session.
  line({
    id: "m-1", from: "coordinator", to: "lane-a",
    from_timestamp: "2026-08-03T10:00:00Z", to_timestamp: "2026-08-03T10:05:00Z",
    kind: "request", reply_to: null, body: "read CONTRACT.md and report", ref: null,
  }),
].join("\n");

const registry = JSON.stringify({
  "lane-a": { sessionId: "sess-a", harness: "claude", tmux: "instant-lane-a" },
  "lane-b": "sess-b",
});

test("mail preview renders one agent's queue with threaded replies and ack state", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // relTime cells render against Date.now(); freeze it so the baseline is
  // date-independent.
  await page.clock.setFixedTime(new Date("2026-08-03T12:00:00Z"));
  await page.addInitScript(({ mailDir, envelopes, registry }) => {
    const w = window as Window & { __instantE2eNativeResults?: Record<string, unknown> };
    w.__instantE2eNativeResults = {
      list_dir: (args?: Record<string, unknown>) => {
        if (args?.path === mailDir) {
          return { entries: [
            { name: "bus.ndjson", path: `${mailDir}/bus.ndjson`, is_dir: false },
            { name: "registry.json", path: `${mailDir}/registry.json`, is_dir: false },
          ] };
        }
        throw new Error("no such dir");
      },
      read_text: (args?: Record<string, unknown>) => {
        if (args?.path === `${mailDir}/bus.ndjson`) return envelopes;
        if (args?.path === `${mailDir}/registry.json`) return registry;
        throw new Error("no such file");
      },
    };
  }, { mailDir, envelopes, registry });
  await page.goto("/e2e-mail-preview.html?e2e=1");

  const panel = page.getByTestId("mail-preview");
  await expect(panel).toBeVisible();

  // lane-a's queue only: its request in, its reply out, its note in.
  await expect(page.getByTestId("mail-row-m-1")).toBeVisible();
  await expect(page.getByTestId("mail-row-m-2")).toBeVisible();
  await expect(page.getByTestId("mail-row-m-4")).toBeVisible();
  await expect(page.getByTestId("mail-row-m-3")).toHaveCount(0);
  await expect(page.getByTestId("mail-count")).toHaveText("3 messages · 2 unacked");

  // The appended ack row wins for m-1; the rows with no ack row stay queued.
  await expect(page.getByTestId("mail-row-m-1")).toContainText("acked");
  await expect(page.getByTestId("mail-row-m-4")).toContainText("queued");
  // The reply is threaded under its request and points at the peer, not lane-a.
  await expect(page.getByTestId("mail-row-m-2")).toContainText("↳");
  await expect(page.getByTestId("mail-row-m-2")).toContainText("coordinator");
  // The registry route reaches the header.
  await expect(panel).toContainText("tmux instant-lane-a");

  await expect(panel).toHaveScreenshot("mail-preview.png", { animations: "disabled" });
  expect(pageErrors).toEqual([]);
});
