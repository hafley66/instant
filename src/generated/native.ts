// Generated from ipc/commands.json by scripts/generate-native.mjs.
// Do not edit by hand. Run: corepack pnpm@10.12.4 api:generate
import { nativeTransport } from "../reactive/nativeTransport";

export type CommandName =
  | "list_sessions"
  | "open_session"
  | "write_pty"
  | "resize_pty"
  | "close_pty"
  | "kill_session"
  | "scroll_session"
  | "rogue_agent_sessions"
  | "cdp_open"
  | "cdp_send"
  | "cdp_resize"
  | "cdp_navigate"
  | "cdp_close"
  | "cdp_status"
  | "list_workspaces"
  | "create_workspace"
  | "remove_workspace"
  | "scan_worktrees"
  | "add_worktree"
  | "git_diff"
  | "remove_worktree"
  | "worktree_at"
  | "activity_events"
  | "activity_clear"
  | "activity_log"
  | "capture_set_enabled"
  | "capture_enabled"
  | "rules_get"
  | "rules_set"
  | "activity_rule_matches"
  | "watcher_status"
  | "capture_permissions"
  | "capture_request_screen"
  | "config_get"
  | "config_set"
  | "config_reload"
  | "config_open"
  | "list_dir"
  | "list_dir_meme"
  | "list_dir_recursive"
  | "read_image"
  | "read_text"
  | "save_text"
  | "delete_file"
  | "fs_watch_claim"
  | "fs_watch_release"
  | "harness_session"
  | "harness_sessions"
  | "list_ai_sessions"
  | "read_ai_messages"
  | "latest_ai_message"
  | "make_slack_emoji"
  | "magick_available"
  | "install_imagemagick"
  | "save_meme"
  | "copy_meme_image"
  | "fav_add"
  | "fav_remove"
  | "fav_list"
  | "sprefa_schema"
  | "sprefa_ping"
  | "sprefa_eval"
  | "sprefa_query_sql"
  | "sprefa_rel_source"
  | "screenshot"
  | "open_target"
  | "run_click"
  | "log_append"
  | "log_path"
  | "log_reveal";

export function invoke<T = unknown>(
  command: CommandName,
  args?: Record<string, unknown>,
): Promise<T> {
  return nativeTransport.invoke<T>(command, args);
}

export namespace commands {
  export namespace pty {
    export const listSessions = "list_sessions";
    export const openSession = "open_session";
    export const writePty = "write_pty";
    export const resizePty = "resize_pty";
    export const closePty = "close_pty";
    export const killSession = "kill_session";
    export const scrollSession = "scroll_session";
    export const rogueAgentSessions = "rogue_agent_sessions";
  }

  export namespace cdp {
    export const cdpOpen = "cdp_open";
    export const cdpSend = "cdp_send";
    export const cdpResize = "cdp_resize";
    export const cdpNavigate = "cdp_navigate";
    export const cdpClose = "cdp_close";
    export const cdpStatus = "cdp_status";
  }

  export namespace workspace {
    export const listWorkspaces = "list_workspaces";
    export const createWorkspace = "create_workspace";
    export const removeWorkspace = "remove_workspace";
  }

  export namespace worktrees {
    export const scanWorktrees = "scan_worktrees";
    export const addWorktree = "add_worktree";
    export const gitDiff = "git_diff";
    export const removeWorktree = "remove_worktree";
    export const worktreeAt = "worktree_at";
  }

  export namespace activity {
    export const activityEvents = "activity_events";
    export const activityClear = "activity_clear";
    export const activityLog = "activity_log";
    export const captureSetEnabled = "capture_set_enabled";
    export const captureEnabled = "capture_enabled";
    export const rulesGet = "rules_get";
    export const rulesSet = "rules_set";
    export const activityRuleMatches = "activity_rule_matches";
    export const watcherStatus = "watcher_status";
  }

  export namespace capture {
    export const capturePermissions = "capture_permissions";
    export const captureRequestScreen = "capture_request_screen";
  }

  export namespace config {
    export const configGet = "config_get";
    export const configSet = "config_set";
    export const configReload = "config_reload";
    export const configOpen = "config_open";
  }

  export namespace files {
    export const listDir = "list_dir";
    export const listDirMeme = "list_dir_meme";
    export const listDirRecursive = "list_dir_recursive";
    export const readImage = "read_image";
    export const readText = "read_text";
    export const saveText = "save_text";
    export const deleteFile = "delete_file";
    export const fsWatchClaim = "fs_watch_claim";
    export const fsWatchRelease = "fs_watch_release";
  }

  export namespace harness {
    export const harnessSession = "harness_session";
    export const harnessSessions = "harness_sessions";
  }

  export namespace ledger {
    export const listAiSessions = "list_ai_sessions";
    export const readAiMessages = "read_ai_messages";
    export const latestAiMessage = "latest_ai_message";
  }

  export namespace meme {
    export const makeSlackEmoji = "make_slack_emoji";
    export const magickAvailable = "magick_available";
    export const installImagemagick = "install_imagemagick";
    export const saveMeme = "save_meme";
    export const copyMemeImage = "copy_meme_image";
  }

  export namespace favorites {
    export const favAdd = "fav_add";
    export const favRemove = "fav_remove";
    export const favList = "fav_list";
  }

  export namespace sprefa {
    export const sprefaSchema = "sprefa_schema";
    export const sprefaPing = "sprefa_ping";
    export const sprefaEval = "sprefa_eval";
    export const sprefaQuerySql = "sprefa_query_sql";
    export const sprefaRelSource = "sprefa_rel_source";
  }

  export namespace shell {
    export const screenshot = "screenshot";
    export const openTarget = "open_target";
    export const runClick = "run_click";
    export const logAppend = "log_append";
    export const logPath = "log_path";
    export const logReveal = "log_reveal";
  }
}
