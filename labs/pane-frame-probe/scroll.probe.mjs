// Scroll probe: a tmux pane printing real stored turns, scrolled in copy-mode; the real strip +
// turn debug render each state from instant-serve's pane frame. Asserts placement against the screen.
import { chromium } from "@playwright/test"
import { spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"

const [session, target, outDir] = process.argv.slice(2)
const tmux = (...args) => spawnSync("tmux", args, { encoding: "utf8" }).stdout
const height = Number(tmux("display", "-p", "-t", target, "#{pane_height}").trim())
const failures = []
const b = await chromium.launch()
for (const mode of ["relative", "recent"]) {
  for (const scroll of [0, 40]) {
    tmux("send-keys", "-t", target, "-X", "cancel")
    if (scroll) { tmux("copy-mode", "-t", target); tmux("send-keys", "-t", target, "-X", "-N", String(scroll), "scroll-up") }
    const seen = tmux("capture-pane", "-e", "-p", "-t", target, "-S", String(-scroll), "-E", String(height - 1 - scroll))
    writeFileSync(`${process.cwd()}/labs/pane-frame-probe/capture.txt`, seen)
    const plain = tmux("capture-pane", "-p", "-t", target, "-S", String(-scroll), "-E", String(height - 1 - scroll)).split("\n")
    const p = await b.newPage({ viewport: { width: 1520, height: 1000 } })
    await p.goto(`http://localhost:1431/labs/pane-frame-probe/index.html?ws=ws://127.0.0.1:47791/ws&session=${session}&target=${encodeURIComponent(target)}&mode=${mode}`)
    await p.waitForFunction(() => Number(document.body.dataset.frames ?? 0) > 0, null, { timeout: 20000 })
    await p.waitForTimeout(1200)
    const frame = await p.evaluate(() => window.lastFrame)
    const labels = await p.evaluate(() => [...document.querySelectorAll(".term-turn-debug *")].map((n) => n.textContent.trim()).filter((t) => /^.?\s*t\d+/.test(t)))
    const active = await p.evaluate(() => [...document.querySelectorAll(".asq-strip [data-active='true'], .asq-strip .active")].map((n) => n.getAttribute("data-id") ?? n.textContent))
    const expectedTop = frame.rows - height - scroll
    if (frame.window?.top !== expectedTop) failures.push(`${mode}/${scroll}: window.top ${frame.window?.top} != ${expectedTop}`)
    const placed = frame.turns.filter((t) => t.confidence === "anchored" && t.buffer_start >= frame.window.top && t.buffer_start <= frame.window.bottom)
    for (const t of placed) {
      const row = t.buffer_start - frame.window.top
      const head = t.said.split("\n")[0].slice(0, 24)
      if (!plain[row]?.includes(head)) failures.push(`${mode}/${scroll}: t${t.turn} row ${row} shows ${JSON.stringify(plain[row]?.slice(0, 40))}, turn starts ${JSON.stringify(head)}`)
    }
    console.log(`${mode} scroll=${scroll} window=${JSON.stringify(frame.window)} placed=${placed.map((t) => `t${t.turn}@${t.buffer_start - frame.window.top}`).join(" ")} debug=[${labels.slice(0, 6).join(" | ")}] active=${active.join(",")}`)
    await p.screenshot({ path: `${outDir}/scroll-${mode}-${scroll}.png` })
    await p.close()
  }
}
tmux("send-keys", "-t", target, "-X", "cancel")
await b.close()
console.log(failures.length ? `FAIL\n${failures.join("\n")}` : "PASS")
process.exit(failures.length ? 1 : 0)
