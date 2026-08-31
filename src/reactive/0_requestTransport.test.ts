import { firstValueFrom, of } from "rxjs";
import { describe, expect, it } from "vitest";
import { createRequestEndpoint } from "./0_requestTransport";

describe("createRequestEndpoint", () => {
  it("keeps method, URL, body, response status, and decoded result at one boundary", async () => {
    const requests: unknown[] = [];
    const endpoint = createRequestEndpoint<{ path: string }, { ok: boolean }>({
      request: (input) => ({
        url: `tauri://instant/commands/${input.path}`,
        method: "POST",
        body: { path: input.path },
      }),
      decode: (response) => {
        if (response.status !== 200) throw new Error(String(response.status));
        return response.body as { ok: boolean };
      },
    }, (request) => {
      requests.push(request);
      return of({ status: 200, body: { ok: true } });
    });

    const result = await firstValueFrom(endpoint.execute({ path: "scan_worktrees" }));

    expect({ requests, result }).toMatchInlineSnapshot(`
      {
        "requests": [
          {
            "body": {
              "path": "scan_worktrees",
            },
            "method": "POST",
            "url": "tauri://instant/commands/scan_worktrees",
          },
        ],
        "result": {
          "ok": true,
        },
      }
    `);
  });
});
