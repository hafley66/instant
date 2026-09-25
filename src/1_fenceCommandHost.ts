import { defer, from } from "rxjs";
import { commandPlugin, defaultMdPlugins, type MdFenceCommand, type MdFenceCommandRequest, type MdFenceCommandResult, type MdPlugin } from "@hafley66/md/plugins";
import { invoke } from "./generated/native";
import { settings } from "./0_settings";
import { DEFAULT_FENCE_COMMANDS } from "./state";

// md reads this on every panel render and keys renderer identity on it, so one array per setting value.
let cached: { readonly from: readonly MdFenceCommand[] | null; readonly plugins: readonly MdPlugin[] } | null = null;

export const fenceCommandHost = {
  get mdPlugins(): readonly MdPlugin[] {
    const configured = settings.fenceCommands.$();
    if (cached === null || cached.from !== configured) {
      cached = { from: configured, plugins: [...(configured ?? DEFAULT_FENCE_COMMANDS).map(commandPlugin), ...defaultMdPlugins] };
    }
    return cached.plugins;
  },
  runFenceCommand(request: MdFenceCommandRequest) {
    return defer(() => from(invoke<MdFenceCommandResult>("run_fence_command", { ...request })));
  },
};
