import { expect, it } from "vitest";
import { clickUrl } from "./0_clickUrl";

it("routes network addresses ahead of file lookup without treating filenames as URLs", () => {
  expect(["192.168.1.4", "127.0.0.1:3000/a?q=b", "[::1]:8080", "localhost:1420", "www.example.com", "https://example.com/x", "999.0.0.1", "src/main.ts:42", "obj.method"].map(clickUrl))
    .toMatchInlineSnapshot(`
      [
        "http://192.168.1.4/",
        "http://127.0.0.1:3000/a?q=b",
        "http://[::1]:8080/",
        "http://localhost:1420/",
        "https://www.example.com/",
        "https://example.com/x",
        null,
        null,
        null,
      ]
    `);
});
