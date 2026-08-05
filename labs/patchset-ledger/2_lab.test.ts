import { describe, expect, it } from "vitest";
import { runPatchsetLab } from "./1_lab";

describe("patch-set refs", () => {
  it("maps a two-commit rebase and force-with-lease onto two branch patch sets", () => {
    expect(runPatchsetLab()).toMatchInlineSnapshot(`
      {
        "afterReflogExpiryAndGc": {
          "diff": "base.txt | 2 +-
       1 file changed, 1 insertion(+), 1 deletion(-)",
          "retainedObjects": [
            "commit",
            "commit",
          ],
        },
        "firstPush": {
          "after": {
            "archive": [
              "instant/changes/topic/1 change B",
            ],
            "remote": "patch-set-1",
          },
          "before": {
            "archive": [],
            "remote": "missing",
          },
          "commits": [
            "change A",
            "change B",
          ],
          "event": {
            "localRef": "refs/heads/topic",
            "localSha": "patch-set-1",
            "remoteRef": "refs/heads/topic",
            "remoteSha": "missing",
          },
        },
        "forceWithLeaseAfterRebase": {
          "after": {
            "archive": [
              "instant/changes/topic/1 change B",
              "instant/changes/topic/2 change B",
            ],
            "remote": "patch-set-2",
          },
          "before": {
            "archive": [
              "instant/changes/topic/1 change B",
            ],
            "local": "patch-set-2",
            "remote": "patch-set-1",
          },
          "commits": [
            "change A",
            "change B",
          ],
          "event": {
            "localRef": "refs/heads/topic",
            "localSha": "patch-set-2",
            "remoteRef": "refs/heads/topic",
            "remoteSha": "patch-set-1",
          },
        },
      }
    `);
  });
});
