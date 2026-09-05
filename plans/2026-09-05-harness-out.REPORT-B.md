# Lane B report: instant calls boop-harness

Port of instant's harness logic onto `boop_harness`. All session discovery,
shaping and transcript reading now live in boop-harness; instant keeps only
thin tauri command wrappers.

## Diff stat (lines per file)

```
 src-tauri/src/0_harness_store.rs       |  481 +------------   (kept boop_mux_session only)
 src-tauri/src/0_harness_store_tests.rs |  327 ---------      (deleted, tests now in boop-harness)
 src-tauri/src/bin/instant-harness.rs   |   10 +-              (deviation, see below)
 src-tauri/src/favorites.rs             |    4 +-
 src-tauri/src/harness.rs               |   24 +-
 src-tauri/src/ledger.rs                | 1221 +--------------   (kept AiSession + 3 commands)
 src-tauri/src/lib.rs                   |    2 +-
 src-tauri/src/0_boop.rs                |    1 +               (deviation, see below)
 8 files changed, 64 insertions(+), 2006 deletions(-)
```

- `ledger.rs`: deleted `Editor`, `AiMessage`, `read_claude`, `read_codex`,
  `read_kimi`, `read_opencode`, `iso_to_ms`, `chrono_lite`,
  `codex_session_path`, `kimi_session_path`, `home`, every text helper, every
  `#[test]`. Kept `AiSession` and `read_ai_messages` / `latest_ai_message` /
  `list_ai_sessions` / `editor_tag`.
- `0_harness_store.rs`: deleted `HarnessSession`, `refs`, `sessions`,
  `session_ids`, `resolve`, `messages`, the four `*_shape`,
  `interactive_session_id`, `resolve_registered_session`,
  `route_session_in_pane`, `claude_project_dir`, `claude_session_path`,
  `resume_id`, `mtime`, `created`, `json`, `head_values`, `tail_values`,
  `usage`, `kimi_*`, `wire_num`, and the `#[path]` test mod. Kept only
  `boop_mux_session`, now delegating to `boop_harness::live::session_in_pane`.
- `Cargo.lock`: unchanged (cargo did not rewrite it).

## Acceptance grep

```
$ grep -rn "isSidechain\|turn_context\|wire.jsonl\|opencode.db\|\.claude/projects\|\.codex/sessions\|\.kimi-code" src-tauri/src/
(no output)
```

Clean, including the two files I edited outside the owned list.

## Validation

```
$ cargo test 2>&1 | grep "test result"
test result: ok. 66 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 3.00s
test result: ok. 0 passed; ... (main.rs, bin/instant-harness.rs, doc-tests)

$ cargo clippy --all-targets -- -D warnings
error: could not compile `instant` (lib) due to 12 previous errors
error: could not compile `instant` (lib test) due to 14 previous errors
# 12 errors, ALL pre-existing on the base (see "Could not delete" below)

$ corepack pnpm@10.12.4 install --frozen-lockfile
Done in 447ms using pnpm v10.12.4

$ corepack pnpm@10.12.4 exec tsc --noEmit
(clean, exit 0)

$ corepack pnpm@10.12.4 exec vitest run
Test Files  88 passed (88)
     Tests  474 passed (474)

$ node scripts/generate-native.mjs && git status --short ipc src/generated
(no output — ipc/ and src/generated/ unchanged)
```

Test count: base 90 lib tests − 24 deleted (7 harness_store + 17 ledger) = 66.
Matches exactly; no unexpected drop.

## Could not delete / deviations from the brief

Three things in files outside the owned list had to change to keep the build and
mandatory gates green. All are documented here rather than silently fixed.

1. **`src-tauri/src/bin/instant-harness.rs`** (not an owned file). It imported
   `instant_lib::harness_store::{messages, resolve, sessions}`, which this lane
   deletes. Left as-is it breaks compilation (and therefore `cargo test`).
   Rewrote it to call `boop_harness::Registry` directly
   (`describe_all` / `messages_by_id`), preserving the same CLI and the same
   wire output (`SessionMeta` serializes camelCase, `Message` byte-identical).
   This is the direct consequence of this lane's deletions, so I fixed it
   rather than leave the build red.

2. **`src-tauri/src/0_boop.rs`** (not an owned file). Lane A added
   `image_paste_keys` to `boop_harness::Capabilities`; the stale `static CAPS`
   literal in the `candidate_for` test module (line ~917) lacked the field and
   failed to compile (`E0063`). Added `image_paste_keys: None` — the one-line
   fix required for `cargo test` to pass. This breakage came from Lane A's
   boop-harness change, not this lane.

3. **`cargo clippy --all-targets -- -D warnings` is not clean on the base.**
   12 pre-existing errors, all in files/lines this lane does not own and did
   not touch:
   - `src/kitty.rs:401` bool comparison, `:331` and `:352` chunks_exact
   - `src/cdp.rs:150` `&PathBuf` vs `&Path`, `:378` too many arguments
   - `src/fs.rs:233` and `:304` sort_by_key, `:309` recursion-only param,
     `:331`, `:455` div_ceil
   - `src/meme.rs:153` unused fn, `:369` chunks_exact
   - `src/refresolve.rs:781` clone to slice
   - `src/0_boop.rs:459` contains vs iter().any (line I did not edit)
   - `src/lib.rs:980` unit-value let-binding (line I did not edit)

   None fall inside this lane's changed lines, so this lane adds zero clippy
   warnings. Per the brief's rule 1 I left them in files I do not own. The
   clippy gate cannot go green until those pre-existing issues are fixed.

Everything in the owned-file list was deleted or rewritten as specified. No
harness-specific code remains in `src-tauri` except the deviations above.
