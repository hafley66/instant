import { EMPTY, from, fromEvent, merge, Observable, race, Subscription, timer } from "rxjs"
import {
  catchError,
  filter,
  finalize,
  map,
  switchMap,
  take,
  takeUntil,
  tap,
} from "rxjs/operators"
import { invoke } from "./generated/native"

/** Literal body pasted into the visible tmux pane, then Enter. Override in Config. */
export const PANIC_BODY_DEFAULT = "shut the fuck up"

export type PanicPosition = { x: number; y: number }

export type StfuButtonOptions = {
  /** tmux pane id. Omit to hit whichever pane the tmux client is currently showing. */
  target?: string
  socket?: string
  /** Static body, or a getter so a Config edit applies without remounting. */
  body?: string | (() => string)
  label?: string
  /** Degrees the plate leans away from the viewer. 0 faces you, 90 lies flat. */
  tiltDeg?: number
  /** Degrees the plate twists in the desk plane. */
  twistDeg?: number
  /** "counter" keeps the label facing you, the others let it lie on the cap. */
  labelMode?: "counter" | "flat" | "big" | "engraved"
  /** "clear" wipes the input line first, "paste" appends to a draft, "escape" interrupts only. */
  mode?: "clear" | "paste" | "escape" | (() => "clear" | "paste" | "escape")
  /** Offset in px from the default corner, restored on mount. */
  position?: PanicPosition
  /** Fired once when a long-press drag settles, so the caller can persist it. */
  onMoveEnd?: (position: PanicPosition) => void
  onSent?: (pane: string) => void
  onError?: (message: string) => void
}

const DEFAULTS = {
  body: PANIC_BODY_DEFAULT,
  label: "STFU",
  tiltDeg: 42,
  twistDeg: -8,
  labelMode: "big" as const,
}

/** Hold this long without sliding and the button detaches for repositioning. */
const LONG_PRESS_MS = 350
/** Sliding further than this before the timer fires cancels the gesture. */
const SLOP_PX = 6

/** Mounts the desk button into `host` and returns a teardown. */
export function mountStfuButton(host: HTMLElement, options: StfuButtonOptions = {}): () => void {
  const opts = { ...DEFAULTS, ...options }
  const stage = document.createElement("div")
  stage.className = "stfu-stage"
  stage.style.setProperty("--stfu-tilt", `${opts.tiltDeg}deg`)
  stage.style.setProperty("--stfu-twist", `${opts.twistDeg}deg`)
  stage.dataset.labelMode = opts.labelMode

  const DISCS = 40
  // Each disc is one ring of the cylinder wall, darkening with depth. Stacking real
  // geometry along Z means the wall shortens when pressed instead of vanishing.
  const wall = Array.from({ length: DISCS }, (_, i) => {
    const t = i / (DISCS - 1)
    // start at the cap's rim colour so the wall joins it without a bright band
    const r = Math.round(168 - 94 * t)
    const g = Math.round(18 - 12 * t)
    const b = Math.round(18 - 12 * t)
    return `<span class="stfu-disc" style="--i:${i};--shade:rgb(${r},${g},${b})"></span>`
  }).join("")
  stage.innerHTML = `
    <div class="stfu-plate">
      <button class="stfu-cap" type="button" aria-label="${opts.label}" style="--stfu-discs:${DISCS}">
        ${wall}
        <span class="stfu-top"><span class="stfu-face">${opts.label}</span></span>
      </button>
    </div>
    <output class="stfu-status" aria-live="polite"></output>`

  const cap = stage.querySelector(".stfu-cap") as HTMLButtonElement
  const status = stage.querySelector(".stfu-status") as HTMLElement

  let offset: PanicPosition = { ...(opts.position ?? { x: 0, y: 0 }) }
  const writeOffset = (next: PanicPosition) => {
    offset = next
    host.style.setProperty("--stfu-x", `${next.x}px`)
    host.style.setProperty("--stfu-y", `${next.y}px`)
  }
  writeOffset(offset)

  // A hot reload re-runs the mount without tearing the old one down, which
  // would stack stages and leave a stale pressed cap on top.
  for (const stale of Array.from(host.querySelectorAll(".stfu-stage"))) stale.remove()
  host.appendChild(stage)

  // data-cap names the one current cap state; hover lives in JS so every unit
  // rule shares this writer. is-dragging stays for the cursor and plate shadow.
  let hovering = false
  let hold: "pressed" | "drag" | null = null
  const applyCap = () => {
    const state = hold ?? (hovering ? "hover" : null)
    if (state) stage.dataset.cap = state
    else delete stage.dataset.cap
  }
  const press = () => {
    hold = "pressed"
    applyCap()
  }
  const release = () => {
    hold = null
    applyCap()
  }

  const down$ = fromEvent<PointerEvent>(cap, "pointerdown").pipe(filter(event => event.button === 0))
  const move$ = fromEvent<PointerEvent>(cap, "pointermove")
  // Listening only on `cap` orphans the gesture when capture is lost (window
  // blur, webview steals pointer, focus jump) and the cap stays pressed for good.
  const up$: Observable<unknown> = merge(
    fromEvent<PointerEvent>(cap, "pointerup"),
    fromEvent<PointerEvent>(cap, "pointercancel"),
    fromEvent<PointerEvent>(cap, "lostpointercapture"),
    fromEvent<PointerEvent>(window, "pointerup"),
    fromEvent<PointerEvent>(window, "pointercancel"),
    fromEvent<Event>(window, "blur"),
  )

  // The browser fires click after the pointerup that ended a drag. One flag,
  // cleared on the next pointerdown, keeps repositioning from sending.
  let draggedThisGesture = false

  // One gesture per pointerdown. Three outcomes race: the hold timer arms a
  // drag, an early slide cancels, an early release leaves the click to fire.
  const gestures = down$
    .pipe(
      tap(event => {
        draggedThisGesture = false
        cap.setPointerCapture(event.pointerId)
        press()
      }),
      switchMap(start => {
        const slipped$ = move$.pipe(
          filter(event => Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) > SLOP_PX),
          take(1),
          map(() => "cancel" as const),
        )
        const armed$ = timer(LONG_PRESS_MS).pipe(map(() => "drag" as const))
        const released$ = up$.pipe(take(1), map(() => "tap" as const))

        return race(armed$, slipped$, released$).pipe(
          switchMap(outcome => {
            if (outcome !== "drag") {
              release()
              return EMPTY
            }
            release()
            stage.classList.add("is-dragging")
            hold = "drag"
            applyCap()
            draggedThisGesture = true
            const origin = { ...offset }
            return move$.pipe(
              map(event => ({
                x: origin.x + event.clientX - start.clientX,
                y: origin.y + event.clientY - start.clientY,
              })),
              tap(writeOffset),
              takeUntil(up$),
              finalize(() => {
                stage.classList.remove("is-dragging")
                hold = null
                applyCap()
                opts.onMoveEnd?.({ ...offset })
              }),
            )
          }),
        )
      }),
    )
    .subscribe()

  // exhaustMap is the point: a send in flight swallows further clicks, so the
  // disabled-flag juggling disappears and a mashed button sends once.
  const sends = fromEvent<MouseEvent>(cap, "click")
    .pipe(
      filter(() => !draggedThisGesture),
      tap(() => {
        cap.disabled = true
        status.textContent = "sending"
      }),
      switchMap(() =>
        from(
          invoke<string>("boop_mux_send_keys", {
            body: typeof opts.body === "function" ? opts.body() : opts.body,
            target: opts.target ?? null,
            socket: opts.socket ?? null,
            mode: typeof opts.mode === "function" ? opts.mode() : opts.mode ?? "clear",
          }),
        ).pipe(
          tap(pane => {
            status.textContent = `sent to ${pane}`
            opts.onSent?.(pane)
          }),
          catchError(error => {
            const message = error instanceof Error ? error.message : String(error)
            status.textContent = message
            opts.onError?.(message)
            return EMPTY
          }),
          finalize(() => {
            cap.disabled = false
          }),
        ),
      ),
    )
    .subscribe()

  // Replaces the old :hover unit rule. Pointer capture during a drag retargets
  // boundary events to the cap, so the enter/leave pair stays balanced.
  const hovers = merge(
    fromEvent<PointerEvent>(cap, "pointerenter").pipe(map(() => true)),
    fromEvent<PointerEvent>(cap, "pointerleave").pipe(map(() => false)),
  )
    .pipe(
      tap(over => {
        hovering = over
        applyCap()
      }),
    )
    .subscribe()

  const teardown = new Subscription()
  teardown.add(gestures)
  teardown.add(sends)
  teardown.add(hovers)

  return () => {
    teardown.unsubscribe()
    stage.remove()
  }
}
