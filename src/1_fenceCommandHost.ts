import { defer, from } from "rxjs";
import { commandPlugin, defaultMdPlugins, type MdFenceCommandRequest, type MdFenceCommandResult } from "@hafley66/md/plugins";
import { invoke } from "./generated/native";
import { settings } from "./0_settings";
import { DEFAULT_FENCE_COMMANDS } from "./state";

export const fenceCommandHost = {
  get mdPlugins() {
    return [
      ...(settings.fenceCommands.$() ?? DEFAULT_FENCE_COMMANDS).map(commandPlugin),
      ...defaultMdPlugins,
    ];
  },
  runFenceCommand(request: MdFenceCommandRequest) {
    return defer(() => from(invoke<MdFenceCommandResult>("run_fence_command", { ...request })));
  },
};
