// The ⌘-hover card's show/hide decision, with no DOM in it.
//
// The card used to survive a ⌘-click because every hide path went through a
// terminal-element event (mousemove, mouseleave) or a Meta keyup, and a click
// that swaps the active panel fires none of them: the terminal is hidden, so
// the pointer never "leaves" it, and the keyup lands on the new panel or is
// eaten by the window losing focus. The dismissal set therefore includes the
// three events that mean "the user is done with this terminal": the click was
// dispatched, the tab went hidden, the window lost focus.

export type InspectorEvent =
  | "meta-down"
  | "meta-up"
  | "pointer-enter-token"
  | "pointer-leave-terminal"
  | "card-enter"
  | "card-leave"
  | "click-dispatched"
  | "tab-hidden"
  | "window-blur"
  | "escape"
  | "pin";

export interface InspectorState {
  readonly visible: boolean;
  readonly pinned: boolean;
  readonly metaHeld: boolean;
  readonly insideCard: boolean;
}

export const INSPECTOR_HIDDEN: InspectorState = {
  visible: false,
  pinned: false,
  metaHeld: false,
  insideCard: false,
};

// A hidden card holds no pin and no pointer: the popover is gone, so its
// mouseleave will never arrive to clear those flags later.
const dismiss = (metaHeld: boolean): InspectorState => ({
  visible: false,
  pinned: false,
  metaHeld,
  insideCard: false,
});

export function inspectorNext(state: InspectorState, event: InspectorEvent): InspectorState {
  switch (event) {
    case "meta-down":
      return { ...state, metaHeld: true };

    // Meta up leaves the card alone while it is pinned or while the pointer is
    // reading it; otherwise the hover gesture is over.
    case "meta-up":
      return state.pinned || state.insideCard
        ? { ...state, metaHeld: false }
        : dismiss(false);

    // Only a held Meta over an openable token paints the card.
    case "pointer-enter-token":
      return state.metaHeld ? { ...state, visible: true } : state;

    // The card overlaps the terminal, so leaving the terminal is usually the
    // pointer's trip into the card. It closes only a card nothing is holding
    // open: no pin, no pointer already inside, no Meta still down.
    case "pointer-leave-terminal":
      return state.pinned || state.insideCard || state.metaHeld ? state : dismiss(state.metaHeld);

    case "card-enter":
      return { ...state, insideCard: true };

    case "card-leave":
      return state.pinned || state.metaHeld
        ? { ...state, insideCard: false }
        : dismiss(state.metaHeld);

    // A dispatched ⌘-click has already opened the file somewhere else; the
    // preview it was previewing is redundant, held Meta or not.
    case "click-dispatched":
    case "escape":
    case "tab-hidden":
      return dismiss(state.metaHeld);

    // A blurred window will not deliver the Meta keyup, so Meta is dropped here
    // rather than left stuck on until the next keydown.
    case "window-blur":
      return dismiss(false);

    case "pin":
      return { ...state, visible: true, pinned: true };
  }
}

// Mutable holder so a listener reads `machine.visible` right after `send`.
export class InspectorMachine {
  state: InspectorState = INSPECTOR_HIDDEN;

  get visible(): boolean {
    return this.state.visible;
  }

  get pinned(): boolean {
    return this.state.pinned;
  }

  send(event: InspectorEvent): InspectorState {
    this.state = inspectorNext(this.state, event);
    return this.state;
  }
}
