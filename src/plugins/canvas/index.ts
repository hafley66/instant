import { registerPlugin } from "../../plugin";
import { CanvasWorkspacePanel } from "./0_CanvasPanel";

export { CanvasWorkspacePanel } from "./0_CanvasPanel";

export function registerCanvasPlugin(): void {
  registerPlugin({
    id: "canvas",
    panels: [
      {
        id: "canvas",
        title: "Canvas",
        icon: "◇",
        iconLabel: "Canvas",
        component: CanvasWorkspacePanel,
      },
    ],
  });
}
