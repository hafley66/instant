// rpc: the whole ipc/commands.json table behind one dispatch. Each arm parses
// camelCase params (the casing Tauri v2 accepts) and calls the same impl.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;

use crate::host::Host;
use crate::services::Services;

fn parse<T: serde::de::DeserializeOwned>(name: &str, params: Value) -> Result<T, String> {
    serde_json::from_value(params).map_err(|e| format!("{name}: {e}"))
}

fn ok<T: serde::Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

fn res<T: serde::Serialize>(r: Result<T, String>) -> Result<Value, String> {
    r.and_then(ok)
}

/// Async impls and commands join tauri's runtime; dispatch itself runs on a
/// blocking thread, never inside an async context.
fn wait<F: std::future::Future>(fut: F) -> F::Output {
    tauri::async_runtime::block_on(fut)
}

/// One arm per command name in ipc/commands.json (103). Arc'd host/services
/// because open_session/cdp_open/fs_watch_claim spawn threads holding clones.
pub fn dispatch(
    name: &str,
    host: Arc<dyn Host>,
    services: Arc<Services>,
    params: Value,
) -> Result<Value, String> {
    match name {
        // pty
        "list_sessions" => ok(wait(crate::pty::list_sessions())),
        "open_session" => {
            let p: OpenSessionArgs = parse(name, params)?;
            res(crate::pty::open_session_impl(
                host, services, p.id, p.name, p.tmux_target, p.command, p.cwd, p.cols, p.rows,
                p.graphics, p.cell_w, p.cell_h, p.attach_only,
            ))
        }
        "write_pty" => {
            let p: WritePtyArgs = parse(name, params)?;
            res(crate::pty::write_pty_impl(&services, p.id, p.data))
        }
        "resize_pty" => {
            let p: ResizePtyArgs = parse(name, params)?;
            res(crate::pty::resize_pty_impl(&services, p.id, p.cols, p.rows, p.cell_w, p.cell_h))
        }
        "close_pty" => {
            let p: ClosePtyArgs = parse(name, params)?;
            crate::pty::close_pty_impl(&services, p.id);
            ok(())
        }
        "kill_session" => {
            let p: KillSessionArgs = parse(name, params)?;
            res(crate::pty::kill_session_impl(&services, p.name))
        }
        "scroll_session" => {
            let p: ScrollSessionArgs = parse(name, params)?;
            wait(crate::pty::scroll_session(p.name, p.up, p.lines));
            ok(())
        }
        "tmux_buffer" => res(wait(crate::pty::tmux_buffer())),
        "rogue_agent_sessions" => ok(wait(crate::pty::rogue_agent_sessions())),
        "rename_session_window" => {
            let p: RenameSessionWindowArgs = parse(name, params)?;
            res(wait(crate::pty::rename_session_window(p.name, p.title)))
        }

        // cdp
        "cdp_open" => {
            let p: CdpOpenArgs = parse(name, params)?;
            res(crate::cdp::cdp_open_impl(
                host, services, p.id, p.url, p.width, p.height, p.dpr, p.quality,
            ))
        }
        "cdp_send" => {
            let p: CdpSendArgs = parse(name, params)?;
            res(crate::cdp::cdp_send_impl(&services, p.id, p.method, p.params))
        }
        "cdp_resize" => {
            let p: CdpResizeArgs = parse(name, params)?;
            res(crate::cdp::cdp_resize_impl(&services, p.id, p.width, p.height, p.dpr, p.quality))
        }
        "cdp_navigate" => {
            let p: CdpNavigateArgs = parse(name, params)?;
            res(crate::cdp::cdp_navigate_impl(&services, p.id, p.url))
        }
        "cdp_close" => {
            let p: CdpCloseArgs = parse(name, params)?;
            crate::cdp::cdp_close_impl(&services, p.id);
            ok(())
        }
        "cdp_status" => ok(crate::cdp::cdp_status_impl(&services)),

        // workspace
        "list_workspaces" => ok(crate::workspace::list_workspaces_impl(&services)),
        "create_workspace" => {
            let p: CreateWorkspaceArgs = parse(name, params)?;
            res(crate::workspace::create_workspace_impl(&*host, &services, p.repo, p.branch, p.agent))
        }
        "remove_workspace" => {
            let p: RemoveWorkspaceArgs = parse(name, params)?;
            res(crate::workspace::remove_workspace_impl(&*host, &services, p.id, p.delete_tree))
        }

        // worktrees
        "scan_worktrees" => {
            let p: ScanWorktreesArgs = parse(name, params)?;
            ok(wait(crate::worktrees::scan_worktrees(p.roots, p.max_depth)))
        }
        "add_worktree" => {
            let p: AddWorktreeArgs = parse(name, params)?;
            res(wait(crate::worktrees::add_worktree(p.repo, p.branch)))
        }
        "git_diff" => {
            let p: GitDiffArgs = parse(name, params)?;
            res(wait(crate::worktrees::git_diff(p.path)))
        }
        "remove_worktree" => {
            let p: RemoveWorktreeArgs = parse(name, params)?;
            res(wait(crate::worktrees::remove_worktree(p.repo, p.worktree, p.force)))
        }
        "worktree_at" => {
            let p: WorktreeAtArgs = parse(name, params)?;
            ok(wait(crate::worktrees::worktree_at(p.path)))
        }

        // activity
        "activity_events" => {
            let p: ActivityEventsArgs = parse(name, params)?;
            res(crate::activity::activity_events_impl(&services, p.limit, p.source))
        }
        "activity_clear" => res(crate::activity::activity_clear_impl(&services)),
        "activity_log" => {
            let p: ActivityLogArgs = parse(name, params)?;
            res(crate::activity::activity_log_impl(&*host, &services, p.source, p.kind, p.title, p.text))
        }
        "capture_set_enabled" => {
            let p: CaptureSetEnabledArgs = parse(name, params)?;
            crate::activity::capture_set_enabled_impl(&*host, &services, p.on);
            ok(())
        }
        "capture_enabled" => ok(crate::activity::capture_enabled_impl(&services)),
        "rules_get" => ok(crate::activity::rules_get_impl(&services)),
        "rules_set" => {
            let p: RulesSetArgs = parse(name, params)?;
            res(crate::activity::rules_set_impl(&services, p.rules))
        }
        "activity_rule_matches" => {
            let p: ActivityRuleMatchesArgs = parse(name, params)?;
            res(crate::activity::activity_rule_matches_impl(&services, p.limit))
        }
        "watcher_status" => ok(crate::activity::watcher_status_impl(&services)),

        // capture
        "capture_permissions" => ok(crate::capture::capture_permissions_impl(&services)),
        "capture_request_screen" => ok(crate::capture::capture_request_screen()),

        // config
        "config_get" => ok(crate::config::config_get_impl(&services)),
        "config_set" => {
            let p: ConfigSetArgs = parse(name, params)?;
            res(crate::config::config_set_impl(
                &services, p.exclude_sites, p.exclude_files, p.exclude_apps, p.terminal_fonts,
            ))
        }
        "config_reload" => res(crate::config::config_reload_impl(&services)),
        "config_open" => res(crate::config::config_open_impl(&services)),

        // files
        "list_dir" => {
            let p: ListDirArgs = parse(name, params)?;
            res(wait(crate::fs::list_dir(p.path)))
        }
        "list_dir_meme" => {
            let p: ListDirArgs = parse(name, params)?;
            res(wait(crate::fs::list_dir_meme(p.path)))
        }
        "list_dir_recursive" => {
            let p: ListDirRecursiveArgs = parse(name, params)?;
            res(wait(crate::fs::list_dir_recursive(p.path, p.exts, p.max_depth, p.max_files)))
        }
        "search_files" => {
            let p: SearchFilesArgs = parse(name, params)?;
            res(wait(crate::fs::search_files(p.path, p.max_files)))
        }
        "resolve_ref" => {
            let p: ResolveRefArgs = parse(name, params)?;
            res(wait(crate::refresolve::resolve_ref_impl(&*host, p.token, p.cwd, p.sessions)))
        }
        "clear_ref_index" => {
            crate::refresolve::clear_ref_index();
            ok(())
        }
        "read_git_blob" => {
            let p: ReadGitBlobArgs = parse(name, params)?;
            res(wait(crate::refresolve::read_git_blob(p.repo, p.rev, p.path)))
        }
        "read_image" => {
            let p: ReadPathArgs = parse(name, params)?;
            res(wait(crate::fs::read_image(p.path)))
        }
        "read_text" => {
            let p: ReadPathArgs = parse(name, params)?;
            res(wait(crate::fs::read_text(p.path)))
        }
        "save_text" => {
            let p: SaveTextArgs = parse(name, params)?;
            res(wait(crate::fs::save_text(p.path, p.contents)))
        }
        "delete_file" => {
            let p: ReadPathArgs = parse(name, params)?;
            res(wait(crate::fs::delete_file(p.path)))
        }
        "stash_drop" => {
            let p: StashDropArgs = parse(name, params)?;
            ok(wait(crate::fs::stash_drop(p.paths)))
        }
        "fs_watch_claim" => {
            let p: FsWatchClaimArgs = parse(name, params)?;
            res(crate::fs_watch::fs_watch_claim_impl(host, &services, p.claim_id, p.path, p.recursive))
        }
        "fs_watch_release" => {
            let p: FsWatchReleaseArgs = parse(name, params)?;
            res(crate::fs_watch::fs_watch_release_impl(&services, p.claim_id))
        }

        // harness
        "harness_session" => {
            let p: HarnessSessionArgs = parse(name, params)?;
            ok(wait(crate::harness::harness_session(p.tool, p.cwd)))
        }
        "harness_sessions" => {
            let p: HarnessSessionArgs = parse(name, params)?;
            ok(wait(crate::harness::harness_sessions(p.tool, p.cwd)))
        }

        // boop
        "boop_turns" => {
            let p: BoopTurnsArgs = parse(name, params)?;
            res(wait(crate::boop::boop_turns(p.session)))
        }
        "boop_turns_recent" => {
            let p: BoopTurnsRecentArgs = parse(name, params)?;
            res(wait(crate::boop::boop_turns_recent(p.since, p.harness)))
        }
        "boop_sync_session" => {
            let p: BoopSyncSessionArgs = parse(name, params)?;
            res(wait(crate::boop::boop_sync_session(p.session, p.harness)))
        }
        "boop_locate_turns" => {
            let p: BoopLocateTurnsArgs = parse(name, params)?;
            res(wait(crate::boop::boop_locate_turns(p.lines, p.turns)))
        }
        "boop_favorite_add" => {
            let p: BoopFavoriteAddArgs = parse(name, params)?;
            res(wait(crate::boop::boop_favorite_add(p.turn)))
        }
        "boop_favorites" => res(wait(crate::boop::boop_favorites())),
        "boop_favorite_toggle" => {
            let p: BoopFavoriteToggleArgs = parse(name, params)?;
            res(wait(crate::boop::boop_favorite_toggle(p.turn, p.note)))
        }
        "boop_tags_recent" => {
            let p: BoopTagsRecentArgs = parse(name, params)?;
            res(wait(crate::boop::boop_tags_recent(p.limit)))
        }
        "boop_tags_search" => {
            let p: BoopTagsSearchArgs = parse(name, params)?;
            res(wait(crate::boop::boop_tags_search(p.query, p.limit)))
        }
        "boop_tags_apply" => {
            let p: BoopTagsApplyArgs = parse(name, params)?;
            res(wait(crate::boop::boop_tags_apply(p.note, p.source)))
        }
        "boop_tags_for" => {
            let p: BoopTagsForArgs = parse(name, params)?;
            res(wait(crate::boop::boop_tags_for(p.source)))
        }
        "boop_turn_comments" => {
            let p: BoopTurnCommentsArgs = parse(name, params)?;
            res(wait(crate::boop::boop_turn_comments(p.tab, p.sessions)))
        }
        "boop_turn_comment_upsert" => {
            let p: BoopTurnCommentUpsertArgs = parse(name, params)?;
            res(wait(crate::boop::boop_turn_comment_upsert(p.comment)))
        }
        "boop_turn_comment_delete" => {
            let p: BoopTurnCommentDeleteArgs = parse(name, params)?;
            res(wait(crate::boop::boop_turn_comment_delete(p.client_id)))
        }
        "boop_turn_comments_sent" => {
            let p: BoopTurnCommentsSentArgs = parse(name, params)?;
            res(wait(crate::boop::boop_turn_comments_sent(p.client_ids)))
        }
        "boop_turn_annotations" => {
            let p: BoopTurnAnnotationsArgs = parse(name, params)?;
            res(wait(crate::boop::boop_turn_annotations(p.sessions)))
        }
        "boop_turn_comment_forks" => {
            let p: BoopTurnCommentForksArgs = parse(name, params)?;
            res(wait(crate::boop::boop_turn_comment_forks(p.comment_ids)))
        }
        "boop_config_presets" => res(wait(crate::boop::boop_config_presets())),
        "boop_lanes" => res(wait(crate::boop::boop_lanes())),
        "boop_lane_events" => {
            let p: BoopLaneEventsArgs = parse(name, params)?;
            res(wait(crate::boop::boop_lane_events(p.since_ms)))
        }
        "boop_agent_touches" => {
            let p: BoopAgentTouchesArgs = parse(name, params)?;
            res(wait(crate::boop::boop_agent_touches(p.sessions, p.limit)))
        }
        "boop_session_graph" => {
            let p: BoopSessionGraphArgs = parse(name, params)?;
            res(wait(crate::boop::boop_session_graph(p.history_since_ms)))
        }

        // boop_mux
        "boop_mux_capture" => {
            let p: BoopMuxTargetArgs = parse(name, params)?;
            res(wait(crate::boop_tmux::boop_mux_capture(p.target, p.socket)))
        }
        "boop_mux_session" => {
            let p: BoopMuxTargetArgs = parse(name, params)?;
            res(wait(crate::harness_store::boop_mux_session(p.target, p.socket)))
        }
        "boop_mux_send_keys" => {
            let p: BoopMuxSendKeysArgs = parse(name, params)?;
            res(wait(crate::boop_tmux::boop_mux_send_keys(p.body, p.target, p.socket, p.mode)))
        }
        "boop_mux_exit_copy_mode" => {
            let p: BoopMuxTargetArgs = parse(name, params)?;
            res(wait(crate::boop_tmux::boop_mux_exit_copy_mode(p.target, p.socket)))
        }

        // ledger
        "list_ai_sessions" => {
            let p: ListAiSessionsArgs = parse(name, params)?;
            res(wait(crate::ledger::list_ai_sessions(p.editor, p.cwd)))
        }
        "read_ai_messages" => {
            let p: ReadAiMessagesArgs = parse(name, params)?;
            res(wait(crate::ledger::read_ai_messages(p.editor, p.session_id, p.cwd, p.after_seq)))
        }
        "latest_ai_message" => {
            let p: LatestAiMessageArgs = parse(name, params)?;
            res(wait(crate::ledger::latest_ai_message(p.editor, p.session_id, p.cwd)))
        }

        // meme
        "make_slack_emoji" => {
            let p: MakeSlackEmojiArgs = parse(name, params)?;
            res(wait(crate::meme::make_slack_emoji(p.input, p.output)))
        }
        "magick_available" => ok(wait(crate::meme::magick_available())),
        "install_imagemagick" => res(wait(crate::meme::install_imagemagick())),
        "save_meme" => {
            let p: SaveMemeArgs = parse(name, params)?;
            res(wait(crate::meme::save_meme(p.path, p.data_url)))
        }
        "copy_meme_image" => {
            let p: CopyMemeImageArgs = parse(name, params)?;
            res(wait(crate::meme::copy_meme_image(p.data_url)))
        }

        // favorites
        "fav_add" => {
            let p: FavAddArgs = parse(name, params)?;
            res(crate::favorites::fav_add_impl(&*host, &services, p.msg, p.cwd))
        }
        "fav_remove" => {
            let p: FavRemoveArgs = parse(name, params)?;
            res(crate::favorites::fav_remove_impl(&*host, &services, p.editor, p.session_id, p.message_id))
        }
        "fav_list" => res(crate::favorites::fav_list_impl(&services)),

        // sprefa (kept compiling, unregistered in Tauri; same here it dispatches)
        "sprefa_schema" => {
            let p: SprefaRootArgs = parse(name, params)?;
            res(wait(crate::sprefa_plugin::commands::sprefa_schema(p.root)))
        }
        "sprefa_ping" => {
            let p: SprefaRootArgs = parse(name, params)?;
            res(wait(crate::sprefa_plugin::commands::sprefa_ping(p.root)))
        }
        "sprefa_eval" => {
            let p: SprefaEvalArgs = parse(name, params)?;
            res(wait(crate::sprefa_plugin::commands::sprefa_eval(p.root, p.text)))
        }
        "sprefa_query_sql" => {
            let p: SprefaQuerySqlArgs = parse(name, params)?;
            res(wait(crate::sprefa_plugin::commands::sprefa_query_sql(p.root, p.sql, p.params)))
        }
        "sprefa_rel_source" => {
            let p: SprefaRelSourceArgs = parse(name, params)?;
            res(wait(crate::sprefa_plugin::commands::sprefa_rel_source(p.root, p.rel)))
        }

        // shell: six commands whose bodies live in lib.rs behind an AppHandle.
        // lib.rs is off-limits to this lane, so serve carries matching impls.
        "screenshot" => res(screenshot_impl()),
        "open_target" => {
            let p: OpenTargetArgs = parse(name, params)?;
            res(open_target_impl(p.target, p.cwd))
        }
        "run_click" => {
            let p: RunClickArgs = parse(name, params)?;
            res(run_click_impl(p.command, p.cwd))
        }
        "log_append" => {
            let p: LogAppendArgs = parse(name, params)?;
            log_append_impl(&*host, p.line);
            ok(())
        }
        "log_path" => Ok(serde_json::Value::String(crate::host::state_dir(&*host)?
            .join("instant.log")
            .to_string_lossy()
            .into_owned())),
        "log_reveal" => {
            let path = crate::host::state_dir(&*host)?.join("instant.log");
            std::process::Command::new("/usr/bin/open")
                .arg("-R")
                .arg(&path)
                .spawn()
                .map_err(|e| e.to_string())?;
            ok(())
        }

        _ => Err(format!("unknown command {name}")),
    }
}

// ---- params structs (camelCase keys, the casing Tauri v2 accepts) -----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenSessionArgs {
    id: String,
    name: String,
    tmux_target: Option<String>,
    command: Option<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    graphics: Option<bool>,
    cell_w: Option<u16>,
    cell_h: Option<u16>,
    attach_only: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WritePtyArgs {
    id: String,
    data: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResizePtyArgs {
    id: String,
    cols: u16,
    rows: u16,
    cell_w: Option<u16>,
    cell_h: Option<u16>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClosePtyArgs {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KillSessionArgs {
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScrollSessionArgs {
    name: String,
    up: bool,
    lines: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameSessionWindowArgs {
    name: String,
    title: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CdpOpenArgs {
    id: String,
    url: String,
    width: u32,
    height: u32,
    dpr: f64,
    quality: u8,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CdpSendArgs {
    id: String,
    method: String,
    params: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CdpResizeArgs {
    id: String,
    width: u32,
    height: u32,
    dpr: f64,
    quality: u8,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CdpNavigateArgs {
    id: String,
    url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CdpCloseArgs {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateWorkspaceArgs {
    repo: String,
    branch: String,
    agent: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveWorkspaceArgs {
    id: String,
    delete_tree: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScanWorktreesArgs {
    roots: Vec<String>,
    max_depth: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddWorktreeArgs {
    repo: String,
    branch: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitDiffArgs {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveWorktreeArgs {
    repo: String,
    worktree: String,
    force: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeAtArgs {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivityEventsArgs {
    limit: Option<i64>,
    source: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivityLogArgs {
    source: String,
    kind: String,
    title: String,
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureSetEnabledArgs {
    on: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RulesSetArgs {
    rules: Vec<crate::activity::Rule>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivityRuleMatchesArgs {
    limit: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigSetArgs {
    exclude_sites: Vec<String>,
    exclude_files: Vec<String>,
    exclude_apps: Vec<String>,
    terminal_fonts: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListDirArgs {
    path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListDirRecursiveArgs {
    path: Option<String>,
    exts: Option<Vec<String>>,
    max_depth: Option<usize>,
    max_files: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchFilesArgs {
    path: Option<String>,
    max_files: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveRefArgs {
    token: String,
    cwd: String,
    sessions: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadGitBlobArgs {
    repo: String,
    rev: String,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadPathArgs {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveTextArgs {
    path: String,
    contents: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StashDropArgs {
    paths: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FsWatchClaimArgs {
    claim_id: String,
    path: String,
    recursive: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FsWatchReleaseArgs {
    claim_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HarnessSessionArgs {
    tool: String,
    cwd: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoopTurnsArgs {
    session: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoopTurnsRecentArgs {
    since: i64,
    harness: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoopSyncSessionArgs {
    session: String,
    harness: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoopLocateTurnsArgs {
    lines: Vec<crate::boop::LogicalLine>,
    turns: Vec<crate::boop::BoopTurn>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoopFavoriteAddArgs {
    turn: crate::boop::BoopTurn,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoopFavoriteToggleArgs {
    turn: crate::boop::BoopTurn,
    note: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoopTagsRecentArgs {
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoopTagsSearchArgs {
    query: String,
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoopTagsApplyArgs {
    note: String,
    source: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoopTagsForArgs {
    source: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoopTurnCommentsArgs {
    tab: String,
    sessions: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoopTurnCommentUpsertArgs {
    comment: crate::boop::BoopTurnComment,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoopTurnCommentDeleteArgs {
    client_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoopTurnCommentsSentArgs {
    client_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoopTurnAnnotationsArgs {
    sessions: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoopTurnCommentForksArgs {
    comment_ids: Vec<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoopLaneEventsArgs {
    since_ms: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoopAgentTouchesArgs {
    sessions: Vec<String>,
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoopSessionGraphArgs {
    history_since_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoopMuxTargetArgs {
    target: String,
    socket: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoopMuxSendKeysArgs {
    body: String,
    target: Option<String>,
    socket: Option<String>,
    mode: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListAiSessionsArgs {
    editor: String,
    cwd: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadAiMessagesArgs {
    editor: String,
    session_id: String,
    cwd: String,
    after_seq: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LatestAiMessageArgs {
    editor: String,
    session_id: String,
    cwd: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MakeSlackEmojiArgs {
    input: String,
    output: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveMemeArgs {
    path: String,
    data_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CopyMemeImageArgs {
    data_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FavAddArgs {
    msg: crate::AiMessage,
    cwd: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FavRemoveArgs {
    editor: String,
    session_id: String,
    message_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SprefaRootArgs {
    root: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SprefaEvalArgs {
    root: String,
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SprefaQuerySqlArgs {
    root: String,
    sql: String,
    params: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SprefaRelSourceArgs {
    root: String,
    rel: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenTargetArgs {
    target: String,
    cwd: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunClickArgs {
    command: String,
    cwd: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogAppendArgs {
    line: String,
}

// ---- shell impls: mirrors of the private lib.rs bodies against &dyn Host ----

fn screenshot_impl() -> Result<String, String> {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let path = std::env::temp_dir().join(format!("instant-shot-{ts}.png"));
    // Absolute path: a GUI context without /usr/sbin in PATH silently fails.
    std::process::Command::new("/usr/sbin/screencapture")
        .arg("-i")
        .arg(&path)
        .status()
        .map_err(|e| e.to_string())?;
    if path.exists() {
        Ok(path.to_string_lossy().into_owned())
    } else {
        Err("screenshot cancelled".into())
    }
}

// Drop a trailing :line or :line:col so "src/main.ts:42" resolves as a file.
fn strip_line_suffix(s: &str) -> &str {
    let mut base = s;
    for _ in 0..2 {
        match base.rsplit_once(':') {
            Some((head, tail)) if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) => {
                base = head;
            }
            _ => break,
        }
    }
    base
}

// Expand a leading ~ and resolve relative paths against the pane cwd.
fn resolve_path(raw: &str, cwd: &str) -> Result<std::path::PathBuf, String> {
    let home = || std::env::var_os("HOME").map(std::path::PathBuf::from).ok_or("no HOME");
    let p = if raw == "~" {
        home()?
    } else if let Some(rest) = raw.strip_prefix("~/") {
        home()?.join(rest)
    } else {
        std::path::PathBuf::from(raw)
    };
    Ok(if p.is_absolute() {
        p
    } else {
        std::path::PathBuf::from(cwd).join(p)
    })
}

fn open_target_impl(target: String, cwd: String) -> Result<String, String> {
    let t = target.trim();
    if t.is_empty() {
        return Err("empty".into());
    }
    let scheme_ok = t.split_once("://").is_some_and(|(s, _)| {
        !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
    });
    if t.starts_with("www.") || scheme_ok {
        let url = if t.starts_with("www.") {
            format!("https://{t}")
        } else {
            t.to_string()
        };
        std::process::Command::new("/usr/bin/open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok("url".into());
    }
    let path = resolve_path(strip_line_suffix(t), &cwd)?;
    if !path.exists() {
        return Err(format!("not found: {}", path.display()));
    }
    std::process::Command::new("/usr/bin/open")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok("path".into())
}

fn run_click_impl(command: String, cwd: String) -> Result<String, String> {
    let dir = match cwd.trim() {
        "" => std::env::var("HOME").unwrap_or_else(|_| ".".into()),
        c => c.to_string(),
    };
    let out = std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg(&command)
        .current_dir(&dir)
        .env("PATH", crate::pty::path_env())
        .output()
        .map_err(|e| e.to_string())?;
    let mut s = String::from_utf8_lossy(&out.stdout).into_owned();
    const CAP: usize = 200_000;
    if s.len() > CAP {
        s.truncate(CAP);
        s.push_str("\n… (truncated)");
    }
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail: Vec<&str> = stderr.lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect();
        let code = out.status.code().map_or("signal".to_string(), |c| c.to_string());
        return Err(format!("exit {code}: {}\n{}", tail.join("\n").trim(), s.trim()).trim().to_string());
    }
    Ok(s)
}

fn log_append_impl(host: &dyn Host, line: String) {
    let Ok(dir) = crate::host::state_dir(host) else { return };
    let path = dir.join("instant.log");
    const CAP: u64 = 2_000_000;
    if std::fs::metadata(&path)
        .map(|m| m.len() > CAP)
        .unwrap_or(false)
    {
        if let Ok(data) = std::fs::read(&path) {
            let keep = data.len().saturating_sub(CAP as usize / 2);
            let _ = std::fs::write(&path, &data[keep..]);
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        use std::io::Write;
        let _ = f.write_all(line.as_bytes());
        let _ = f.write_all(b"\n");
    }
}
