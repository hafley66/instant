// The feed's contract, pinned without a server and without a socket: the frames
// are ordinary `events` payloads, so a Subject stands in for the transport.
import { Subject } from "rxjs"
import { describe, expect, it } from "vitest"
import { invoke } from "./generated/native"
import { squaresFeed, watchSquares, type Strip } from "./1_agentSquaresFeed"

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
  tags: { [`turn:${session}:2`]: ["rust"] },
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
          "rows": 3,
          "session": "s1",
          "tags": {
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
          "rows": 4,
          "session": "s1",
          "tags": {
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

  it("starts one watcher and stops it on teardown", async () => {
    const calls: Array<[string, Record<string, unknown>]> = []
    const send: typeof invoke = async (command, args) => {
      calls.push([command, args ?? {}])
      return undefined as never
    }

    const stop = await watchSquares({ pty: "p1", session: "s1", target: "lane-a:0.0" }, send)
    await stop()

    expect(calls).toEqual([
      ["squares_watch", { pty: "p1", session: "s1", target: "lane-a:0.0" }],
      ["squares_unwatch", { pty: "p1" }],
    ])
  })
})
