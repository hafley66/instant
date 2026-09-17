// The pinned turn card: one turn, its tags and its favorite, opened by a click on
// the turn's square in the strip or on the turn's own rect in the debug overlay.
//
// The card is placed once, at the click point, and never again. A strip
// re-projection moves the squares (by `transform`) while the reader is reading,
// so a card that followed its square would slide out from under the pointer that
// opened it: `open` writes `left`/`top` a single time, clamped into the pane,
// and nothing here observes scroll, resize or the strip afterwards.
//
// Its actions are the right-click menu's own: the star is the same
// `favoriteBoopTurn` write and the tags go through the same `askTags` +
// `applyTags` pair on the same `turn:<session>:<turn>` source. What the card
// draws comes from the store rather than from the click, so a card opened after
// a toggle agrees with the menu that wrote it.
import { flashStatus } from "./core"
import { invoke } from "./generated/native"
import { applyTags, askTags, boopFavorites, boopTurnsForSession, favoriteBoopTurn } from "./favorites"
import type { BoopTurn } from "./0_terminalTurnVisibility"
import type { TurnMark } from "./1_agentSquaresMarks"
import "./1_turnPanel.css"

export type { TurnMark }

/** The turn a card may carry: the six fields `favoriteBoopTurn` hands the store,
 *  so a caller already holding the turn (the strip's frame, the debug overlay's
 *  projection) lets the star write without a read. A caller carrying only the
 *  source leaves it out and the card resolves the turn itself. */
export type TurnPayload = {
  session: string
  harness: string
  turn: number
  ts: number
  role: string
  said: string
}

/** Everything a card draws and where it starts. `x`/`y` are the click point in
 *  the pane element's own coordinates, which is the box the card positions in. */
export type TurnPanelTarget = {
  /** The turn's id, `${session}:${turn}`: the key the strip's squares carry. */
  id: string
  /** `turn:${session}:${turn}`: the source favorites and tags are written to. */
  source: string
  /** The header line. Whoever knows the turn builds it. */
  at: string
  /** The turn's text. Escapes are stripped here, so `said` passes as-is. */
  preview: string
  marks: TurnMark
  /** The turn the star writes, when the caller holds it. Without it the star
   *  reads the turn back from the session's ledger window, which is a window of
   *  recent turns and does not reach an old one. */
  turn?: TurnPayload
  x: number
  y: number
}

/** The store keeps a turn's text as it was written, so a `said` carries the real
 *  ESC byte, sometimes its own `\x1b` spelling, and a newline as the two
 *  characters `\n`. None of the three reads in a card. */
const escapeText = /\u001b\[[0-9;]*[A-Za-z]|\\x1b\[[0-9;]*[A-Za-z]|\\u001b\[[0-9;]*[A-Za-z]/g
const literalNewline = /\\n/g

/** The marks a card starts from when its caller has no frame-read tags: the
 *  favorites cache answers the star for every source and the tags for the turns
 *  under it. The debug overlay's turns are never in a strip frame, so they start
 *  here. */
export function cachedMarks(source: string): TurnMark {
  const row = boopFavorites.find((favorite) => favorite.source === source)
  return { favorite: !!row, tags: row?.tags ?? [] }
}

/** In the order they were learned, each tag once. */
function mergeTags(...groups: string[][]): string[] {
  const out: string[] = []
  for (const group of groups) for (const tag of group) if (!out.includes(tag)) out.push(tag)
  return out
}

/** The one open card. A pane holds two instances of this class (the strip's
 *  squares and the debug overlay's rows), and a reader reads one turn at a time,
 *  so opening a card closes whichever one was open. */
let pinned: TurnPanel | null = null

export class TurnPanel {
  private card = document.createElement("div")
  private at = document.createElement("div")
  private star = document.createElement("button")
  private tagLane = document.createElement("div")
  private body = document.createElement("div")
  private target: TurnPanelTarget | null = null
  /** The tags this card draws, seeded from the click and replaced by the store's
   *  own answer for the source. */
  private tags: string[] = []
  private favorited = false

  constructor(private host: HTMLElement) {
    this.card.className = "turn-panel"
    this.card.setAttribute("role", "dialog")

    this.at.className = "turn-panel-at"
    this.star.type = "button"
    this.star.className = "turn-panel-star"
    this.star.addEventListener("click", () => void this.toggleFavorite())
    const head = document.createElement("div")
    head.className = "turn-panel-head"
    head.append(this.at, this.star)

    this.tagLane.className = "turn-panel-tags"
    const edit = document.createElement("button")
    edit.type = "button"
    edit.className = "turn-panel-edit"
    edit.textContent = "edit tags"
    edit.addEventListener("click", () => void this.editTags())
    const tagRow = document.createElement("div")
    tagRow.className = "turn-panel-tagrow"
    tagRow.append(this.tagLane, edit)

    this.body.className = "turn-panel-body"
    this.card.append(head, tagRow, this.body)
  }

  get isOpen(): boolean {
    return this.target !== null
  }

  open(target: TurnPanelTarget): void {
    // The same rect opens and closes its own card: a second click on a square is
    // the reader saying they are done with it.
    if (this.target?.id === target.id) {
      this.close()
      return
    }
    // One card at a time, whichever rect asked for it.
    if (pinned && pinned !== this) pinned.close()
    pinned = this
    if (this.target === null) {
      this.host.append(this.card)
      // Capture, and on `window`: xterm's own key handler sits on its textarea
      // and consumes Escape (it is a byte the terminal sends), so a listener at
      // the document never sees the key at all. Capture at the window is the
      // only place that runs before the terminal can swallow it.
      window.addEventListener("keydown", this.onKey, true)
      // Capture, so a click that lands elsewhere closes this card before that
      // click's own handler opens the next one.
      document.addEventListener("pointerdown", this.onDown, true)
    }
    this.target = target
    this.favorited = target.marks.favorite
    this.tags = mergeTags(target.marks.tags, cachedMarks(target.source).tags)
    this.paint()
    this.place(target)
    void this.readTags(target)
  }

  close(): void {
    if (this.target === null) return
    this.target = null
    if (pinned === this) pinned = null
    this.card.remove()
    window.removeEventListener("keydown", this.onKey, true)
    document.removeEventListener("pointerdown", this.onDown, true)
  }

  dispose(): void {
    this.close()
  }

  private readonly onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") this.close()
  }

  private readonly onDown = (event: PointerEvent) => {
    if (!this.owns(event)) this.close()
  }

  /** Whether a pointerdown belongs to this card. Anything inside the card does;
   *  so does the turn's own rect, because that rect's click handler runs next and
   *  a second click on it is how the card closes. Both the strip's square and the
   *  overlay's row name their turn in a data attribute, so one test reads both. */
  private owns(event: PointerEvent): boolean {
    const node = event.target
    if (!(node instanceof Element)) return false
    if (this.card.contains(node)) return true
    const id = this.target?.id
    if (!id) return false
    const rect = node.closest<HTMLElement>("[data-turn], [data-turn-id]")
    return rect?.dataset.turn === id || rect?.dataset.turnId === id
  }

  /** Written once per open and clamped into the pane, which clips. Nothing moves
   *  the card afterwards: a frame that re-projects the strip under it leaves it
   *  where the reader put it. */
  private place(target: TurnPanelTarget): void {
    const width = this.card.offsetWidth
    const height = this.card.offsetHeight
    const left = Math.max(0, Math.min(target.x, this.host.clientWidth - width))
    const top = Math.max(0, Math.min(target.y, this.host.clientHeight - height))
    this.card.style.left = `${left}px`
    this.card.style.top = `${top}px`
  }

  private paint(): void {
    const target = this.target
    if (!target) return
    this.at.textContent = target.at
    this.star.textContent = this.favorited ? "✓ favorited" : "★ favorite"
    this.star.setAttribute("aria-pressed", String(this.favorited))
    this.tagLane.replaceChildren()
    if (this.tags.length) {
      for (const tag of this.tags) {
        const chip = document.createElement("span")
        chip.className = "turn-panel-tag"
        chip.textContent = `#${tag}`
        this.tagLane.append(chip)
      }
    } else {
      const none = document.createElement("span")
      none.className = "turn-panel-none"
      none.textContent = "no tags"
      this.tagLane.append(none)
    }
    this.body.textContent = target.preview.replace(escapeText, "").replace(literalNewline, "\n")
  }

  /** The store's own tags for the source. The frame's read can be a second old
   *  and the overlay's caller has no frame at all, so the card asks once and the
   *  answer outranks what it was seeded with. */
  private async readTags(target: TurnPanelTarget): Promise<void> {
    const tags = await invoke<string[]>("boop_tags_for", { source: target.source }).catch(() => null)
    if (tags === null || this.target !== target) return
    this.tags = tags
    this.paint()
  }

  private async toggleFavorite(): Promise<void> {
    const target = this.target
    if (!target) return
    const turn = target.turn ?? (await this.turnFor(target.source))
    if (!turn) {
      flashStatus("favorite: that turn is outside the ledger window")
      return
    }
    await favoriteBoopTurn(turn)
    if (this.target !== target) return
    // The cache is the store's answer, not ours: `favoriteBoopTurn` replaced it.
    const marks = cachedMarks(target.source)
    this.favorited = marks.favorite
    this.tags = mergeTags(this.tags, marks.tags)
    this.paint()
  }

  private async editTags(): Promise<void> {
    const target = this.target
    if (!target) return
    const note = await askTags("tags for this turn")
    if (!note) return
    const applied = await applyTags(note, target.source)
    if (this.target !== target) return
    this.tags = mergeTags(this.tags, applied)
    this.paint()
    flashStatus(applied.length ? `tagged ${applied.join(", ")}` : "no tag in that text")
  }

  /** The turn a card names. `boop_favorite_toggle` stores the turn's own text,
   *  so it is handed the turn and not just its source; a card carries only the
   *  source, so the turn is read back from the session's ledger window, which is
   *  the row the right-click menu holds. */
  private async turnFor(source: string): Promise<BoopTurn | null> {
    const parts = /^turn:(.*):(\d+)$/.exec(source)
    if (!parts) return null
    const turns = await boopTurnsForSession(parts[1])
    return turns.find((turn) => turn.turn === Number(parts[2])) ?? null
  }
}
