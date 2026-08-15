// Closing a dock tab releases its PTY client. The tmux session remains alive.
// Session termination is reserved for explicit kill controls.
import type { IViewerTabPolicy } from "./0_types";

export const ViewerTabPolicy: IViewerTabPolicy = {
  closeAction() {
    return "detach";
  },
};
