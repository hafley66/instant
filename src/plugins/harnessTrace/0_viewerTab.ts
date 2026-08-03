// What closing a tab does to its tmux session. Pure (no store, no invoke) so
// terminal.ts's close path and vitest read the same rule.
import type { IViewerTabPolicy } from "./0_types";

export const ViewerTabPolicy: IViewerTabPolicy = {
  closeAction({ viewer, agent }) {
    if (viewer) return "detach";
    return agent ? "kill" : "detach";
  },
};
