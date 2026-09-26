// The real strip and turn-debug components on a recorded pane, fed by instant-serve's pane frame.
import "xp.css"
import "@xterm/xterm/css/xterm.css"
import "../../src/styles.css"
import "../../src/1_agentSquares.css"
import { Terminal } from "@xterm/xterm"
import { TerminalAgentSquares } from "../../src/1_agentSquares"
import { TerminalTurnDebugOverlay } from "../../src/0_turnDebugOverlay"
import { stripVisibility } from "../../src/2_stripVisibility"
import { SQUARES_EVENT, type Strip } from "../../src/1_agentSquaresFeed"
import { nativeEvent$ } from "../../src/reactive/nativeTransport"

const query = new URLSearchParams(location.search)
const session = query.get("session") ?? ""
const target = query.get("target") ?? ""
const capture = await (await fetch("./capture.txt")).text()
const rows = capture.replace(/\n$/, "").split("\n")
const el = document.getElementById("pane") as HTMLElement
const term = new Terminal({ cols: 180, rows: rows.length, scrollback: 0, fontSize: 13 })
term.open(el)
await new Promise<void>((done) => term.write(rows.join("\r\n"), done))
const visibility = stripVisibility(term, () => session)
new TerminalTurnDebugOverlay(term, el, visibility)
visibility.effects.subscribe()
nativeEvent$<Strip>(SQUARES_EVENT).subscribe((frame) => {
  document.body.dataset.frames = String(Number(document.body.dataset.frames ?? 0) + 1)
  ;(window as unknown as { lastFrame: Strip }).lastFrame = frame
})
await new TerminalAgentSquares(el, { pty: "probe", session, target }, { mode: query.get("mode") === "recent" ? "recent" : "relative", userKeep: 4 }, () => {}).start()
