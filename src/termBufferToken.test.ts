/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { bufferClickToken } from "./termBufferToken";

// terminal.ts's front gate, copied so this test does not load the app module.
const looksOpenable = (tok: string): boolean =>
  /:\/\//.test(tok) || /^www\./.test(tok) || /[/~]/.test(tok) || /\.[a-z0-9]/i.test(tok);

async function screen(cols: number, bytes: string): Promise<Terminal> {
  const term = new Terminal({ cols, rows: 12, allowProposedApi: true });
  await new Promise<void>((done) => term.write(bytes, done));
  return term;
}

// The first row holding each needle: its text, xterm's wrap flag, and what a
// ⌘-click two cells into the needle sends.
function clicks(term: Terminal, needles: string[]) {
  const buf = term.buffer.active;
  return needles.map((needle) => {
    for (let row = 0; row < buf.length; row++) {
      const line = buf.getLine(row)!;
      const text = line.translateToString(true);
      const at = text.indexOf(needle);
      if (at < 0) continue;
      return { row, text, isWrapped: line.isWrapped, sent: bufferClickToken(buf, row, at + Math.min(2, needle.length - 1), looksOpenable) };
    }
    return { needle, row: -1 };
  });
}

describe("bufferClickToken", () => {
  // Claude's TUI hard-wrapped the lab path mid-word at its own width and
  // wrote CRLF, so xterm holds two unwrapped rows; prose follows the tail.
  const head = "  labs/20260924.0.the-gang-runs-a-program-as-data-t";
  const tail = "  hrough-differential-dataflow/ is the lab dir.";

  it("rejoins a TUI-wrapped relative directory clicked on either row", async () => {
    const term = await screen(head.length, `⏺ Wrote the plan into the lab directory:\r\n${head}\r\n${tail}\r\n`);
    expect(clicks(term, ["labs/", "hrough-", "the lab dir."])).toMatchInlineSnapshot(`
      [
        {
          "isWrapped": false,
          "row": 1,
          "sent": {
            "narrow": "labs/20260924.0.the-gang-runs-a-program-as-data-t",
            "wide": "labs/20260924.0.the-gang-runs-a-program-as-data-through-differential-dataflow/",
          },
          "text": "  labs/20260924.0.the-gang-runs-a-program-as-data-t",
        },
        {
          "isWrapped": false,
          "row": 2,
          "sent": {
            "narrow": "hrough-differential-dataflow/",
            "wide": "labs/20260924.0.the-gang-runs-a-program-as-data-through-differential-dataflow/",
          },
          "text": "  hrough-differential-dataflow/ is the lab dir.",
        },
        {
          "isWrapped": false,
          "row": 2,
          "sent": {
            "narrow": "the",
            "wide": "the",
          },
          "text": "  hrough-differential-dataflow/ is the lab dir.",
        },
      ]
    `);
  });

  it("chains a path the TUI wrapped over three rows", async () => {
    const rows = ["  labs/20260924.0.the-gang-runs-a-", "  program-as-data-through-differential-", "  dataflow/ is the lab dir."];
    const term = await screen(40, rows.map((text) => `${text}\r\n`).join(""));
    expect(clicks(term, ["labs/", "program-", "dataflow/"])).toMatchInlineSnapshot(`
      [
        {
          "isWrapped": false,
          "row": 0,
          "sent": {
            "narrow": "labs/20260924.0.the-gang-runs-a-",
            "wide": "labs/20260924.0.the-gang-runs-a-program-as-data-through-differential-dataflow/",
          },
          "text": "  labs/20260924.0.the-gang-runs-a-",
        },
        {
          "isWrapped": false,
          "row": 1,
          "sent": {
            "narrow": "program-as-data-through-differential-",
            "wide": "labs/20260924.0.the-gang-runs-a-program-as-data-through-differential-dataflow/",
          },
          "text": "  program-as-data-through-differential-",
        },
        {
          "isWrapped": false,
          "row": 2,
          "sent": {
            "narrow": "dataflow/",
            "wide": "labs/20260924.0.the-gang-runs-a-program-as-data-through-differential-dataflow/",
          },
          "text": "  dataflow/ is the lab dir.",
        },
      ]
    `);
  });

  it("joins a path xterm itself wrapped", async () => {
    const term = await screen(40, "  see /tmp/term-e2e/src/mdview/MdPanel.tsx for the fix\r\n");
    expect(clicks(term, ["/tmp/", "sx"])).toMatchInlineSnapshot(`
      [
        {
          "isWrapped": false,
          "row": 0,
          "sent": {
            "narrow": "/tmp/term-e2e/src/mdview/MdPanel.tsx",
            "wide": "/tmp/term-e2e/src/mdview/MdPanel.tsx",
          },
          "text": "  see /tmp/term-e2e/src/mdview/MdPanel.t",
        },
        {
          "isWrapped": true,
          "row": 1,
          "sent": {
            "narrow": "/tmp/term-e2e/src/mdview/MdPanel.tsx",
            "wide": "/tmp/term-e2e/src/mdview/MdPanel.tsx",
          },
          "text": "sx for the fix",
        },
      ]
    `);
  });

  it("keeps each path of an absolute block as the row's own candidate", async () => {
    const paths = ["/tmp/isj-x/01-alpha.txt", "/tmp/isj-x/02-beta.txt", "/tmp/isj-x/03-gamma.txt"];
    const term = await screen(80, paths.map((path) => `${path}\r\n`).join(""));
    expect(clicks(term, paths)).toMatchInlineSnapshot(`
      [
        {
          "isWrapped": false,
          "row": 0,
          "sent": {
            "narrow": "/tmp/isj-x/01-alpha.txt",
            "wide": "/tmp/isj-x/01-alpha.txt/tmp/isj-x/02-beta.txt/tmp/isj-x/03-gamma.txt",
          },
          "text": "/tmp/isj-x/01-alpha.txt",
        },
        {
          "isWrapped": false,
          "row": 1,
          "sent": {
            "narrow": "/tmp/isj-x/02-beta.txt",
            "wide": "/tmp/isj-x/01-alpha.txt/tmp/isj-x/02-beta.txt/tmp/isj-x/03-gamma.txt",
          },
          "text": "/tmp/isj-x/02-beta.txt",
        },
        {
          "isWrapped": false,
          "row": 2,
          "sent": {
            "narrow": "/tmp/isj-x/03-gamma.txt",
            "wide": "/tmp/isj-x/01-alpha.txt/tmp/isj-x/02-beta.txt/tmp/isj-x/03-gamma.txt",
          },
          "text": "/tmp/isj-x/03-gamma.txt",
        },
      ]
    `);
  });
});
