// Where a square sits when nobody can see its turn. The matcher measures the
// turns that are on screen; instant does not own the pane's rendering, so the
// rest of the rolling window is extrapolated from those measurements. Nothing
// here reads the DOM, the store or IPC: it is a pure function of the visible
// turn projection and the viewport, so the strip moves on a scroll without a
// single query.
//
// The chain, and where this module sits in it:
//
//   grid rows + `BoopTurn[]`            boop / xterm
//     -> `VisibleTurn[]`                the matcher; spans + sourceBufferRows
//     -> `TurnSample[]`                 samplesFrom: rows and lines in the viewport
//     -> `Estimates` + `Placement[]`    measure, placeWindow
//     -> `StripLayout`                  stripLayout: y, scale, the on-screen block
import type { SquareKind } from "./0_agentSquareVisual"
import { kindOf } from "./1_agentSquaresModel"
import type { VisibleTurn } from "./0_terminalTurnVisibility"

/** A viewport in buffer rows, inclusive. */
export type RowWindow = { top: number; bottom: number }

/** One turn the strip draws, transcript order, oldest first. `total` is the
 *  turn's own line count from the projection — it rides on `said`, so it costs
 *  no read. */
export type WindowTurn = { id: string; kind: SquareKind; total: number }

/** What the matcher measured for one turn, clipped to the viewport. */
export type TurnSample = {
  id: string
  kind: SquareKind
  /** The turn's own first buffer row, unclipped: the anchor placement uses. */
  turnStart: number
  /** The rows of it the viewport holds, inclusive. */
  start: number
  end: number
  /** The turn's own lines that landed inside the viewport. */
  lines: number
  total: number
}

export type Estimates = {
  /** Screen rows per logical line, per kind. Never below 1: wrapping cannot use
   *  fewer rows than the turn has lines. */
  kappa: Record<SquareKind, number>
  /** Rows nobody attributed between two adjacent sampled turns, per kind of the
   *  newer one. Blank lines and separators live here. */
  gamma: Record<SquareKind, number>
  /** The worst wrap this window measured, which is the clamp's ceiling. */
  kappaMax: number
}

export type Placement = {
  id: string
  kind: SquareKind
  /** Estimated first buffer row of the whole turn. */
  start: number
  /** Estimated buffer rows for the whole turn, seen or not. */
  rows: number
  total: number
  /** Fraction of the turn inside the viewport; 1 when nothing was measured.
   *  `0 < seen < 1` is a turn the reader is halfway through. */
  seen: number
  measured: boolean
}

export type SquareLayout = { id: string; y: number; scale: number; active: boolean }

export type StripLayout = {
  squares: SquareLayout[]
  /** Estimated rows the whole window occupies, the strip's denominator. */
  span: number
  /** The on-screen range, in the same 0..track space the squares use. */
  block: { top: number; height: number }
  /** Map a buffer row to the strip's track, so anything else can be drawn in
   *  the same space the squares use. */
  rowAt: (row: number) => number
}

export type StripOptions = {
  squareHeight: number
  stripMax: number
  /** Scale given to a turn twice the window's median: `1 + flex` at `2 × L_ref`. */
  ratioFlex: number
  scaleMin: number
  scaleMax: number
  blockMin: number
}

/** Pinned by measurement on a busy pane, not by taste; see the plan's open
 *  list. `squareHeight` and `stripMax` mirror the CSS. */
export const STRIP_DEFAULTS: StripOptions = {
  squareHeight: 9,
  stripMax: 320,
  ratioFlex: 0.35,
  scaleMin: 0.7,
  scaleMax: 1.9,
  blockMin: 6,
}

const KINDS: SquareKind[] = ["user", "agent", "tool", "other"]

const zeroed = () => KINDS.reduce((out, kind) => ({ ...out, [kind]: 0 }), {} as Record<SquareKind, number>)

/** A turn's own lines, the projection's count: the text is already in memory. */
export function linesOf(said: string): number {
  return Math.max(1, said.split("\n").length)
}

/**
 * What the viewport shows of each turn that reaches it. `rows` comes from the
 * matcher's span, `lines` from its per-line row mapping, so a turn that is
 * halfway off screen still reports how much of itself it showed.
 */
export function samplesFrom(turns: VisibleTurn[], viewport: RowWindow): TurnSample[] {
  const samples: TurnSample[] = []
  for (const turn of turns) {
    const start = Math.max(turn.bufferStart, viewport.top)
    const end = Math.min(turn.bufferEnd, viewport.bottom)
    if (end < start) continue
    const total = linesOf(turn.said)
    const mapped = turn.regions.flatMap((region) => region.sourceBufferRows ?? [])
    const inside = mapped.filter((row) => row !== null && row >= start && row <= end).length
    samples.push({
      id: turn.id,
      kind: kindOf(turn.role),
      turnStart: turn.bufferStart,
      start,
      end,
      // A turn with no row mapping (a region that never projected) falls back to
      // one line per visible row, which is the least it can have shown.
      lines: inside > 0 ? inside : Math.min(total, end - start + 1),
      total,
    })
  }
  return samples.sort((a, b) => a.start - b.start)
}

/** The window's turns, oldest first, as the estimator wants them. */
export function windowOf(turns: VisibleTurn[]): WindowTurn[] {
  return [...turns]
    .sort((a, b) => a.bufferStart - b.bufferStart)
    .map((turn) => ({ id: turn.id, kind: kindOf(turn.role), total: linesOf(turn.said) }))
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

/**
 * `kappa` and `gamma` from what is on screen.
 *
 * `kappa` is measured wrap: the rows the viewport holds of a turn over the lines
 * it holds of the same turn, pooled per kind. Nothing is assumed about wrapping
 * — a pane that wraps every long line simply reports a bigger `kappa`. `gamma`
 * is the mean unattributed run between two adjacent sampled turns (blank lines,
 * separators, anything the matcher did not attribute), which is what turns a
 * line count into a distance down the screen.
 */
export function measure(samples: TurnSample[], viewport: RowWindow): Estimates {
  const numerator = zeroed()
  const denominator = zeroed()
  let kappaMax = 1
  for (const sample of samples) {
    const rows = sample.end - sample.start + 1
    const lines = Math.max(1, sample.lines)
    numerator[sample.kind] += rows
    denominator[sample.kind] += lines
    kappaMax = Math.max(kappaMax, rows / lines)
  }
  const everyNumerator = KINDS.reduce((sum, kind) => sum + numerator[kind], 0)
  const everyDenominator = KINDS.reduce((sum, kind) => sum + denominator[kind], 0)
  const pooled = everyDenominator > 0 ? clamp(everyNumerator / everyDenominator, 1, kappaMax) : 1
  const kappa = zeroed()
  for (const kind of KINDS) {
    kappa[kind] = denominator[kind] > 0 ? clamp(numerator[kind] / denominator[kind], 1, kappaMax) : pooled
  }

  const gaps = zeroed()
  const boundaries = zeroed()
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]
    const current = samples[index]
    const top = Math.max(previous.end + 1, viewport.top)
    const bottom = Math.min(current.start - 1, viewport.bottom)
    if (bottom < top) continue
    gaps[current.kind] += bottom - top + 1
    boundaries[current.kind] += 1
  }
  const everyGap = KINDS.reduce((sum, kind) => sum + gaps[kind], 0)
  const everyBoundary = KINDS.reduce((sum, kind) => sum + boundaries[kind], 0)
  const pooledGap = everyBoundary > 0 ? everyGap / everyBoundary : 0
  const gamma = zeroed()
  for (const kind of KINDS) {
    gamma[kind] = boundaries[kind] > 0 ? gaps[kind] / boundaries[kind] : pooledGap
  }
  return { kappa, gamma, kappaMax }
}

/** One turn's whole height when nothing of it is on screen. Clamped at both
 *  ends: never fewer rows than the turn has lines, never more than the worst
 *  wrap this window measured allows. */
export function estimateRows(turn: WindowTurn, estimates: Estimates): number {
  const kappa = estimates.kappa[turn.kind]
  return clamp(kappa * turn.total, turn.total, estimates.kappaMax * turn.total)
}

/**
 * Every turn in the window, placed in buffer rows.
 *
 * A measured turn keeps its own span. The turns between two measured turns
 * share the exact gap the two of them left, in proportion to their estimated
 * size, so the interval's ends stay true. The turns outside the measured range
 * are stacked outward from the nearest anchor. A last forward pass keeps the
 * order from inverting.
 */
export function placeWindow(
  window: WindowTurn[],
  samples: TurnSample[],
  estimates: Estimates,
  viewport: RowWindow,
): Placement[] {
  const byId = new Map(samples.map((sample) => [sample.id, sample]))
  const placements: Placement[] = window.map((turn) => {
    const sample = byId.get(turn.id)
    if (!sample) {
      return {
        id: turn.id,
        kind: turn.kind,
        start: Number.NaN,
        rows: estimateRows(turn, estimates),
        total: turn.total,
        seen: 1,
        measured: false,
      }
    }
    const rows = sample.end - sample.start + 1
    const seen = clamp(sample.lines / Math.max(1, sample.total), 1 / Math.max(1, rows), 1)
    const hidden = Math.max(0, sample.total - sample.lines)
    return {
      id: turn.id,
      kind: turn.kind,
      // The turn's own first row is truth; only its height is inferred, from
      // the lines still off screen at this kind's measured wrap.
      start: sample.turnStart,
      rows: rows + hidden * estimates.kappa[sample.kind],
      total: sample.total,
      seen,
      measured: true,
    }
  })
  if (placements.length === 0) return placements

  const overhead = (placement: Placement) => estimates.gamma[placement.kind] ?? 0
  const anchor = placements.findIndex((placement) => placement.measured)
  if (anchor < 0) {
    placements[0].start = viewport.top
  }
  if (anchor > 0) {
    for (let index = anchor - 1; index >= 0; index -= 1) {
      placements[index].start = placements[index + 1].start - placements[index].rows - overhead(placements[index + 1])
    }
  }
  const first = anchor < 0 ? 0 : anchor
  for (let index = first + 1; index < placements.length; index += 1) {
    if (placements[index].measured) continue
    placements[index].start = placements[index - 1].start + placements[index - 1].rows + overhead(placements[index])
  }

  let runStart = -1
  for (let index = 0; index <= placements.length; index += 1) {
    const open = index < placements.length && !placements[index].measured
    if (open) {
      if (runStart < 0) runStart = index
      continue
    }
    const before = runStart - 1
    if (runStart >= 0 && before >= 0 && index < placements.length && placements[index].measured) {
      const run = placements.slice(runStart, index)
      const weights = run.map((placement) => Math.max(1, placement.rows + overhead(placement)))
      const weight = weights.reduce((sum, value) => sum + value, 0)
      const gap = Math.max(0, placements[index].start - (placements[before].start + placements[before].rows))
      let cursor = placements[before].start + placements[before].rows
      run.forEach((placement, offset) => {
        // Each turn owns a share of the exact gap, sized by its estimate plus
        // its own overhead, and sits centred in that share.
        const share = (weights[offset] / weight) * gap
        placement.start = cursor + (share - placement.rows) / 2
        cursor += share
      })
    }
    runStart = -1
  }

  // Order only: every earlier pass accounted for its own overhead, so this
  // repair may not add any of it back.
  for (let index = 1; index < placements.length; index += 1) {
    if (placements[index].measured) continue
    placements[index].start = Math.max(placements[index].start, placements[index - 1].start + placements[index - 1].rows)
  }
  return placements
}

/**
 * The strip: one uniform block per square, its scale flexed by the turn's share
 * of the window and clamped, its position taken from the estimated rows so a
 * heavy tool turn occupies more of the strip than a one-line prompt. `active` is
 * the square covering `focusRow`, which is the row the reader has at the top of
 * the pane.
 */
export function stripLayout(
  placements: Placement[],
  focusRow: number | null,
  viewport: RowWindow,
  options: StripOptions = STRIP_DEFAULTS,
): StripLayout {
  const span = placements.reduce((sum, placement) => sum + placement.rows, 0) || 1
  const track = Math.max(0, options.stripMax - options.squareHeight)
  const rowAt = (row: number) => {
    let behind = 0
    for (const placement of placements) {
      if (row < placement.start) break
      if (row <= placement.start + placement.rows - 1) {
        return ((behind + (row - placement.start)) / span) * track
      }
      behind += placement.rows
    }
    return (behind / span) * track
  }

  const reference = (() => {
    const totals = placements.map((placement) => placement.total).sort((a, b) => a - b)
    if (totals.length === 0) return 1
    const middle = totals.length >> 1
    return totals.length % 2 ? totals[middle] : (totals[middle - 1] + totals[middle]) / 2
  })()

  const active = (() => {
    if (focusRow === null || placements.length === 0) return placements.length - 1
    const hit = placements.findIndex((placement) => focusRow >= placement.start && focusRow <= placement.start + placement.rows - 1)
    if (hit >= 0) return hit
    return focusRow < placements[0].start ? 0 : placements.length - 1
  })()

  const squares = placements.map((placement, index) => ({
    id: placement.id,
    y: rowAt(placement.start),
    // Uniform is 1: a turn at the window's median size keeps the plain square,
    // bigger turns grow and smaller ones shrink, both clamped.
    scale: clamp(1 + options.ratioFlex * (placement.total / Math.max(1, reference) - 1), options.scaleMin, options.scaleMax),
    active: index === active,
  }))

  const top = rowAt(viewport.top)
  const height = Math.max(options.blockMin, rowAt(viewport.bottom + 1) - top)
  return { squares, span, block: { top, height }, rowAt }
}
