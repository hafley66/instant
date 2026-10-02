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

it("recognizes domains and local hostnames while preserving source references", () => {
  expect([
    "example.com", "docs.example.co.uk/guide?q=1#intro", "server.local:8080/path",
    "my-server:3000", "app.test", "README.md", "main.rs", "script.sh",
    "main.ts:42", "src/main.rs", "obj.method", "user@example.com",
    "example.com:99999", "https://example.com/a b",
  ].map(clickUrl)).toMatchInlineSnapshot(`
    [
      "https://example.com/",
      "https://docs.example.co.uk/guide?q=1#intro",
      "http://server.local:8080/path",
      "http://my-server:3000/",
      "http://app.test/",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]
  `);
});
