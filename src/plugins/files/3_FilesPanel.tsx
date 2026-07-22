import type { IDockviewPanelProps } from "dockview";
import { getHomeDir } from "../../core";
import { readPluginState, savePluginState } from "../../pluginState";
import { store } from "../../state";
import { useApp } from "../../useStore";
import type { FilesUi } from "./0_types";
import { FileExplorer } from "./2_FileExplorer";

const PLUGIN_ID = "files";

function initialRoot(): string {
  return readPluginState<FilesUi>(PLUGIN_ID, {}).root || store.get().scanRoot || getHomeDir() || "/";
}

export function FilesPanel(_props: IDockviewPanelProps) {
  useApp();
  const root = initialRoot();
  return (
    <div className="v2-panel">
      <div className="act-bar">
        <span className="spy-title">Files</span>
      </div>
      <FileExplorer
        root={root}
        onRootChange={(path) => savePluginState<FilesUi>(PLUGIN_ID, { root: path })}
      />
    </div>
  );
}
