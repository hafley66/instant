import { invoke } from "./generated/native"

/** Literal body pasted into the visible tmux pane, then Enter. Override in Config. */
export const PANIC_BODY_DEFAULT = "shut the fuck up"

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
  onSent?: (pane: string) => void
  onError?: (message: string) => void
}

const DEFAULTS = { body: PANIC_BODY_DEFAULT, label: "STFU", tiltDeg: 42, twistDeg: -8, labelMode: "big" as const }

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

  const press = () => stage.classList.add("is-pressed")
  const release = () => stage.classList.remove("is-pressed")

  const fire = async () => {
    cap.disabled = true
    status.textContent = "sending"
    try {
      const pane = await invoke<string>("boop_mux_send_keys", {
        body: typeof opts.body === "function" ? opts.body() : opts.body,
        target: opts.target ?? null,
        socket: opts.socket ?? null,
      })
      status.textContent = `sent to ${pane}`
      opts.onSent?.(pane)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      status.textContent = message
      opts.onError?.(message)
    } finally {
      cap.disabled = false
    }
  }

  cap.addEventListener("pointerdown", press)
  cap.addEventListener("pointerup", release)
  cap.addEventListener("pointerleave", release)
  cap.addEventListener("click", fire)
  host.appendChild(stage)

  return () => {
    cap.removeEventListener("pointerdown", press)
    cap.removeEventListener("pointerup", release)
    cap.removeEventListener("pointerleave", release)
    cap.removeEventListener("click", fire)
    stage.remove()
  }
}
