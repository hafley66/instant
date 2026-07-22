import { registerPlugin } from "../../plugin";
import { FilesPanel } from "./3_FilesPanel";

export { FileExplorer } from "./2_FileExplorer";
export { FileSearchTree, filesystemSearchSource } from "./4_FileSearchTree";

export function registerFilesPlugin(): void {
  registerPlugin({
    id: "files",
    panels: [
      {
        id: "files",
        title: "Files",
        icon: "📁",
        iconUrl: "/icons/Explorer100_32x32_4.png",
        iconLabel: "Files",
        component: FilesPanel,
      },
    ],
  });
}
