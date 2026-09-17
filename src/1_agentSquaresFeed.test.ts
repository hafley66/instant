// The feed's contract, pinned without a server and without a socket: the frames
// are ordinary `events` payloads, so a Subject stands in for the transport.
import { Subject } from "rxjs"
import { describe, expect, it } from "vitest"
import { squaresFeed, type Strip } from "./1_agentSquaresFeed"

const frame = (session: string, rows: number): Strip => ({
  session,
  at: 1_700_000_000_000,
  rows,
  turns: [
    {
      session,
      harness: "claude",
      turn: 2,
      ts: 1_700_000_000_000,
      role: "assistant",
      said: "line 1\nline 2",
      id: `${session}:2`,
      bufferStart: 3,
      bufferEnd: 5,
      anchorStart: 3,
      anchorEnd: 4,
      confidence: "anchored",
    },
  ],
  pinned: [
    {
      session,
      harness: "claude",
      turn: 1,
      ts: 1_699_999_000_000,
      role: "user",
      said: "the prompt above the window",
      id: `${session}:1`,
      bufferStart: 0,
      bufferEnd: 0,
      anchorStart: 0,
      anchorEnd: 0,
      confidence: "pinned",
    },
  ],
  tags: { [`turn:${session}:2`]: ["rust"], [`turn:${session}:1`]: ["strip"] },
  layout: {
    mode: "relative",
    rows: 24,
    band: 1,
    squares: [
      { id: `${session}:1`, kind: "user", y: 0, scale: 1, active: false },
      { id: `${session}:2`, kind: "agent", y: 5, scale: 1.1, active: true },
    ],
  },
})

describe("the strip's feed", () => {
  it("carries one session's projections and drops a neighbour's", () => {
    const events = new Subject<Strip>()
    const seen: Strip[] = []
    squaresFeed("s1", events).subscribe((next) => seen.push(next))

    events.next(frame("s2", 20))
    events.next(frame("s1", 3))
    events.next(frame("s1", 4))

    expect(seen).toMatchInlineSnapshot(`
      [
        {
          "at": 1700000000000,
          "layout": {
            "band": 1,
            "mode": "relative",
            "rows": 24,
            "squares": [
              {
                "active": false,
                "id": "s1:1",
                "kind": "user",
                "scale": 1,
                "y": 0,
              },
              {
                "active": true,
                "id": "s1:2",
                "kind": "agent",
                "scale": 1.1,
                "y": 5,
              },
            ],
          },
          "pinned": [
            {
              "anchorEnd": 0,
              "anchorStart": 0,
              "bufferEnd": 0,
              "bufferStart": 0,
              "confidence": "pinned",
              "harness": "claude",
              "id": "s1:1",
              "role": "user",
              "said": "the prompt above the window",
              "session": "s1",
              "ts": 1699999000000,
              "turn": 1,
            },
          ],
          "rows": 3,
          "session": "s1",
          "tags": {
            "turn:s1:1": [
              "strip",
            ],
            "turn:s1:2": [
              "rust",
            ],
          },
          "turns": [
            {
              "anchorEnd": 4,
              "anchorStart": 3,
              "bufferEnd": 5,
              "bufferStart": 3,
              "confidence": "anchored",
              "harness": "claude",
              "id": "s1:2",
              "role": "assistant",
              "said": "line 1
      line 2",
              "session": "s1",
              "ts": 1700000000000,
              "turn": 2,
            },
          ],
        },
        {
          "at": 1700000000000,
          "layout": {
            "band": 1,
            "mode": "relative",
            "rows": 24,
            "squares": [
              {
                "active": false,
                "id": "s1:1",
                "kind": "user",
                "scale": 1,
                "y": 0,
              },
              {
                "active": true,
                "id": "s1:2",
                "kind": "agent",
                "scale": 1.1,
                "y": 5,
              },
            ],
          },
          "pinned": [
            {
              "anchorEnd": 0,
              "anchorStart": 0,
              "bufferEnd": 0,
              "bufferStart": 0,
              "confidence": "pinned",
              "harness": "claude",
              "id": "s1:1",
              "role": "user",
              "said": "the prompt above the window",
              "session": "s1",
              "ts": 1699999000000,
              "turn": 1,
            },
          ],
          "rows": 4,
          "session": "s1",
          "tags": {
            "turn:s1:1": [
              "strip",
            ],
            "turn:s1:2": [
              "rust",
            ],
          },
          "turns": [
            {
              "anchorEnd": 4,
              "anchorStart": 3,
              "bufferEnd": 5,
              "bufferStart": 3,
              "confidence": "anchored",
              "harness": "claude",
              "id": "s1:2",
              "role": "assistant",
              "said": "line 1
      line 2",
              "session": "s1",
              "ts": 1700000000000,
              "turn": 2,
            },
          ],
        },
      ]
    `)
  })
})
