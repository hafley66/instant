# File references, command-click, session cwd, and Git worktree identity

Date: 2026-08-24

Repositories inspected:

- `/Users/chrishafley/projects/instant`
- `/Users/chrishafley/projects/hafley-rxjs`
- `/Users/chrishafley/projects/hafley-rs`

Scope: current Markdown and command-click behavior in Instant, the dependency on `@hafley66/signals`, the Soopy source-coordinate surface, live agent cwd changes, and file-reference resolution across linked Git worktrees.

## System map

```text
terminal pointer                    rendered Markdown link
      |                                      |
      v                                      v
termTokens.ts                       @hafley66/md/MdPanel.tsx
      |                               | #fragment
      v                               | relative *.md
CmdClickGestureTracker                | other href
      |                               v
      v                         MdviewHost.openHref
dispatchClick(token, cwd)              |
      |                                v
CmdClickRouter                   openDocumentHrefInInstant
      |
      +-- file route ------------------------------+
      |    refResolve.ts                           |
      |      cwd -> worktree_at -> fs search       |
      |                                            v
      +-- configured rule -> sh -c in cwd    openPathInInstant
                                                   |
                                   +---------------+---------------+
                                   |                               |
                                 *.md                         other files
                                   |                               |
                              @hafley66/md                    preview/browser

live tmux pane cwd
      |
      v
list_sessions -> store.sessions[].paths -> tabMetaById(...).cwd
      |
      +-> sessionWorktrees[session] accumulates absolute worktree paths

Soopy
  discover(path)
      -> RepositoryId(shared common Git dir)
      -> WorktreeId(per-checkout absolute Git dir)
      -> RepoPath(repository-relative spelling)
      -> SourceRef(repository, revision/worktree, path)
```

The active file-opening path uses absolute filesystem strings. Soopy already defines the identities needed to distinguish a repository, one linked checkout, one revision observation, and one repository-relative file path. Instant does not currently depend on the Soopy crate.

## Current command-click behavior

### Gesture and routing

`src/0_clickRouter.ts` owns two independent pieces:

- `CmdClickGestureTracker` accepts primary-button plus Meta pointerdown, suppresses activation after more than four pixels of movement, and returns the captured token on pointerup.
- `CmdClickRouter` tries registered routes in order and emits the selected route id through an RxJS `Subject`.

`src/terminal.ts` extracts terminal text through `termTokens.ts`, captures the token at pointerdown, and dispatches on pointerup. The request currently has this type:

```ts
type CmdClickRequest = {
  token: string
  cwd: string
  source: "terminal" | "preview" | "results" | "unknown"
}
```

The route table in `src/clickrules.ts` has two entries, in this order:

1. `file`: call `resolveRef(token, cwd)`, open one hit, or show a candidate panel.
2. `configured-rule`: match `settings.clickRules`, replace `$1` with the shell-quoted token, then call native `run_click(command, cwd)`.

The configured rule runs `/bin/sh -c` with `Command.current_dir(cwd)` in `src-tauri/src/lib.rs:664-695`. Empty cwd falls back to `HOME`. The output parser accepts `path:line:text` rows and joins relative output paths to the same cwd.

### Token classification

`looksLikePath` in `src/refResolve.ts:27-30` accepts tokens containing `/` or `~`, or ending in a dot plus 1 to 16 alphanumeric characters. It rejects `http`, `https`, and `www` before this test.

Consequences of the current shape:

- `src/main.ts:12` and `MdPanel.tsx:300` enter the file route.
- `Cargo.toml:41:9` enters the file route after `splitLineRef` parses its supported suffix form.
- `README` and `Makefile` do not enter the file route because they lack a slash and extension-looking suffix.
- URI-like values other than the explicit web exclusions can enter the file route.
- Punctuation removal depends on `termTokens.ts` and the single leading/trailing quote replacement in `resolveRef`; the resolver has no general reference grammar.
- A token can be classified as file-shaped even when its syntax names a directory, URI, revision-qualified path, diagnostic span, or generated display label.

### Resolution order

`resolveRef` in `src/refResolve.ts:117-140` performs:

1. Strip one leading or trailing quote/backtick.
2. Parse a line suffix with `splitLineRef`.
3. Accept an absolute or `~/` path as a hit without checking existence.
4. Ask native `worktree_at(cwd)` for the checkout root.
5. Test `cwd/relative-token`.
6. Test `worktree-root/relative-token`.
7. Walk up to 20,000 gitignore-aware files under the worktree root and rank exact tail or filename matches.
8. Return one hit, up to 50 choices, or miss.

The direct existence test lists the candidate's parent and compares one filename. The directory listing cache lives for 5 seconds. Repository roots are cached without expiry by cwd. Search listings live for 30 seconds.

The search walker in `src-tauri/src/fs.rs:241-295` is filesystem-first and gitignore-aware. `worktree_at` in `src-tauri/src/worktrees.rs:309-330` runs Git discovery, enumerates `git worktree list --porcelain`, then selects the longest containing checkout indirectly by testing each row.

### Non-terminal command-click

`wireDomCmdClick` in `src/clickrules.ts` only handles free text inside `.fs-preview` and `.rg-panel`. It excludes anchors, buttons, and result rows. It uses the focused terminal tab's cwd.

Rendered Markdown lives under mdview classes rather than `.fs-preview`, so free-text command-click does not currently route from the Markdown reading pane. Markdown anchors have their own ordinary-click behavior described below.

## Current Markdown behavior

The package is local to Instant at `packages/md`, exposed as `@hafley66/md`. Instant routes Markdown into it from `openPreviewPanel` through the plugin route registered by `registerMdview`.

`@hafley66/md` has one host interface at `packages/md/src/ports.ts:96-133`. File-related members are:

```ts
interface MdviewHost {
  readText(path: string): Promise<string>
  readImage(path: string): Promise<string>
  listDir(path: string): Promise<{ entries: MdviewFsEntry[] }>
  openHref(href: string, sourcePath: string): Promise<void>
  openPath(path: string): Promise<void>
  watchFile(path: string, onChange: () => void, recursive?: boolean): Promise<() => void>
}
```

All values use display paths. No file coordinate, worktree identity, revision identity, or resolution provenance crosses the host boundary.

The anchor renderer in `packages/md/src/MdPanel.tsx:249-273` handles every ordinary click:

1. `#fragment` expands and scrolls within the current parsed document.
2. Relative or absolute `.md`, `.markdown`, and `.mdx` links resolve from the current document's directory and navigate in the same panel.
3. Every other href calls `host.openHref(href, currentDocumentPath)`.

Instant installs that port as `openDocumentHrefInInstant`. `src/0_documentHref.ts` resolves local document hrefs against the source document. `openPathInInstant` routes extension-bearing targets directly to browser, Markdown, media, PDF, diagram, or source preview handlers.

Markdown images independently join relative `src` values to the current document directory before `readImage`. Markdown's explorer lists the current document's directory and descendants through the shared `FileTree`.

## Relationship to hafley-rxjs

Instant consumes the published `@hafley66/signals@0.1.1` package. The corresponding source repository is `hafley-rxjs/packages/signals`.

The Markdown package uses:

- `Signal` for document cache, path state, collapse state, list-fold state, and persisted UI projection in `packages/md/src/signals.ts`.
- `SignalReact` for render dependency tracking in `packages/md/src/MdPanel.tsx`.

The command-click router uses RxJS `Subject` directly. Session and worktree runtime data uses Instant's own store plus settings-backed signals. No file-reference domain types or Git coordinate types currently come from `hafley-rxjs`.

The existing signals package can carry a reactive session-location model without owning filesystem or Git effects. A boundary shaped as signals plus an injected resolver keeps the native operations in Instant/Soopy:

```ts
type SessionLocationState = {
  sessionId: string
  paneId?: string
  current: LocationObservation | null
  history: readonly LocationObservation[]
}

type LocationObservation = {
  cwd: string
  observedAt: number
  repositoryId?: string
  worktreeId?: string
  worktreeRoot?: string
  repoRelativeCwd?: string
}

declare function sessionLocation(
  initial: SessionLocationState,
): Signal<SessionLocationState>
```

The signature records reactive data only. Native observation, Git discovery, persistence, and file reads remain caller effects.

## Relationship to Soopy in hafley-rs

Soopy is at `hafley-rs/crates/soopy`. Instant's Rust crate already has path dependencies on `boop-mux`, `boop-store`, and `boop-harness` from `hafley-rs`; it has no `soopy` dependency.

Soopy's relevant public coordinates are:

```rust
pub struct RepositoryId(pub Arc<str>);
pub struct WorktreeId(pub Arc<str>);
pub struct RepoPath(pub Arc<str>);

pub struct Repository {
    pub root: PathBuf,
    pub identity: RepositoryId,
    pub worktree: WorktreeId,
}

pub enum RevisionId {
    Worktree {
        worktree: WorktreeId,
        head: Option<ObjectId>,
        dirty: bool,
    },
    Commit(ObjectId),
}

pub struct SourceRef {
    pub repository: RepositoryId,
    pub revision: RevisionId,
    pub path: RepoPath,
}
```

`discover(path)` accepts a directory or file path, calls `git rev-parse --show-toplevel`, canonicalizes the checkout root, hashes `--git-common-dir` into `RepositoryId`, and hashes `--absolute-git-dir` into `WorktreeId` (`_2_repository.rs:9-69`).

The identity split matches the two required relations:

- Every linked checkout of one repository shares `RepositoryId`.
- Each linked checkout has a distinct `WorktreeId`.
- `RepoPath` gives one spelling usable across sibling worktrees.
- `SourceRef` adds revision qualification when a reference must retain the bytes/placement observed at production time.

Soopy currently enumerates and reads source trees and has repository/worktree watchers. Its README labels text search and fuzzy selection as planned library surfaces. The existing `query` and `fzf` behavior is CLI-backed. Instant's `search_files` therefore has no current one-call Soopy replacement with the same candidate-ranking contract.

## Current cwd and worktree tracking

The Rust PTY layer reads all tmux panes using:

```text
tmux list-panes -a -F
  #{session_name}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_pid}
```

It returns distinct `paths` and commands per session. `tabMetaById` in `src/terminal.ts:294-315` uses `live.paths[0]`, then the launch cwd. `tabCwds` returns all live pane paths followed by launch cwd.

`refreshSessions` in `src/worktrees.ts:176-194` maps every current path to a known worktree. `settings.sessionWorktrees[sessionName]` accumulates every matched absolute worktree path. A cwd outside scanned roots calls `worktree_at` and stores its worktree row in `settings.autoWorktrees`.

Observed refresh triggers found in the frontend:

- boot;
- completion of the initial worktree scan;
- summon;
- opening/showing the sessions or worktrees panels;
- terminal open/close and related tab operations;
- explicit session/worktree actions.

No periodic `refreshSessions` timer or tmux cwd-change event was found. An agent can run `cd`, remain in that directory, and command-click before another refresh trigger. During that interval `tabMetaById(...).cwd`, `activeCwd()`, session chips, and the touched-worktree accumulator retain the prior observation.

For sessions with multiple panes, `paths[0]` is a representative cwd. The command-click request does not carry pane identity, even though a viewer tab can attach to a pane target. Resolution can therefore use another pane's cwd.

## File-reference cases and current results

| Produced reference | Current base/identity | Current result |
| --- | --- | --- |
| Absolute path | host filesystem | Accepted immediately without existence check |
| `~/path` | home syntax | Accepted immediately; later native layer expands or handles it |
| `./path` | first live session path | Direct check, then worktree root/search |
| `src/path.ts` | first live session path, then current worktree root | Opens current checkout copy if found |
| bare `File.ts` | current worktree search | One hit or candidate panel |
| Markdown relative link | current Markdown document directory | In-place for Markdown, host route for other types |
| Markdown `#fragment` | parsed document section id | Expands and scrolls |
| `path:line` | string parser | Opens preview at line when parsed |
| `path:line:column` | depends on `splitLineRef`; column has no coordinate field | Column is not propagated through `ResolvedRef` |
| `repo@rev:path` or `HEAD:path` | none | No revision-qualified grammar |
| File reference emitted before agent `cd` | latest refreshed session cwd | Can resolve against stale cwd |
| File reference from a worktree later removed/moved | absolute path only | No repository-relative sibling recovery |
| Same `RepoPath` in sibling linked worktrees | current worktree only | No repository-level candidate expansion |
| Non-Git directory | cwd | Direct check and filesystem search under cwd |

## Coordinate layers

Three coordinate layers serve different lifetimes:

```ts
type ParsedFileRef = {
  raw: string
  pathText: string
  line?: number
  column?: number
  fragment?: string
  revisionText?: string
}

type LocationContext = {
  sessionId?: string
  paneId?: string
  cwd: string
  observedAt: number
  repositoryId?: string
  worktreeId?: string
  worktreeRoot?: string
  repoRelativeCwd?: string
  touchedWorktreeIds: readonly string[]
}

type ResolvedFileRef = {
  parsed: ParsedFileRef
  repositoryId?: string
  worktreeId?: string
  revision?: unknown
  repoPath?: string
  absolutePath: string
  source: "absolute" | "document" | "cwd" | "worktree" | "repository-sibling" | "search"
  exists: boolean
}
```

`ParsedFileRef` lasts as long as the emitted text. `LocationContext` is an observation tied to a session/pane and timestamp. `ResolvedFileRef` is the opened placement. A Soopy `SourceRef` is required when the reference must identify revision-qualified source content after cwd, branch, dirty state, or checkout location changes.

## Resolution sequence using Git identities

```ts
interface FileReferenceResolver {
  parse(text: string): ParsedFileRef | null
  locate(context: LocationContext, ref: ParsedFileRef): Promise<ResolveFileRefResult>
}

type ResolveFileRefResult =
  | { kind: "hit"; value: ResolvedFileRef }
  | { kind: "choices"; values: readonly ResolvedFileRef[] }
  | { kind: "miss"; parsed: ParsedFileRef }
```

Pseudocode body:

```ts
async function locate(context, ref) {
  // 1. Resolve absolute and document-relative syntax.
  // 2. Test the exact observed cwd.
  // 3. Discover or read the current {RepositoryId, WorktreeId, root}.
  // 4. Convert the token to candidate RepoPath spellings.
  // 5. Test the current WorktreeId.
  // 6. If policy permits, test touched sibling WorktreeIds sharing RepositoryId.
  // 7. Search one repository-relative index and project each RepoPath into
  //    eligible worktree roots.
  // 8. Return provenance and all ambiguity rather than discarding identity.
}
```

Reads and writes:

1. A tmux observation writes the session/pane's `LocationContext` signal.
2. Git discovery reads the cwd and returns repository/worktree identity plus canonical roots.
3. The session relation writes `(sessionId, repositoryId, worktreeId, firstSeen, lastSeen)`.
4. A click reads the location captured for the producing surface. Terminal output should retain the pane/cwd observation associated with that output region where available.
5. Resolution reads current-worktree and repository-level file indexes.
6. Opening writes recent-resolution provenance and the panel's source coordinate.
7. File watches key mutable reads by `WorktreeId + RepoPath`, while the OS watcher receives the projected absolute path.

Uniqueness conditions:

- `(RepositoryId, WorktreeId)` selects one checkout in the current Soopy contract.
- `(RepositoryId, WorktreeId, RepoPath)` selects one mutable placement.
- `(RepositoryId, commit ObjectId, RepoPath)` selects one immutable Git placement.
- Absolute path remains a projection used by native I/O and UI display.
- Session name alone does not select a pane or cwd.

## Integration boundaries

### Rust boundary

A Tauri-facing adapter can expose Soopy coordinates without exposing Soopy implementation types directly to every frontend module:

```rust
#[derive(Serialize)]
pub struct LocationCoordinate {
    pub cwd: PathBuf,
    pub repository_id: Option<RepositoryId>,
    pub worktree_id: Option<WorktreeId>,
    pub worktree_root: Option<PathBuf>,
    pub repo_relative_cwd: Option<RepoPath>,
}

#[tauri::command]
async fn locate_path(path: String) -> Result<LocationCoordinate, String>;

#[tauri::command]
async fn resolve_file_reference(
    reference: ParsedFileRef,
    context: LocationCoordinate,
    eligible_worktrees: Vec<WorktreeId>,
) -> Result<ResolveFileRefResult, String>;
```

Soopy supplies discovery and stable identities. The adapter still needs policy and operations absent from current Soopy:

- enumerate linked worktree roots as identity-bearing records suitable for frontend projection;
- repository-relative filename/tail search with limits and ranking inputs;
- convert `WorktreeId + RepoPath` to an absolute path after validating membership;
- return directory/file existence and ambiguity explicitly;
- optionally resolve named revisions and committed blobs for revision-qualified references.

Instant's current `worktrees.rs`, `fs.rs`, and `refResolve.ts` duplicate parts of this boundary using path strings and Git subprocesses. Moving discovery into the adapter changes the return shape of `worktree_at`; moving search requires a Soopy library search surface or a separate Rust search interface.

### TypeScript boundary

The Markdown package can accept coordinates without importing Instant:

```ts
interface FileCoordinate {
  displayPath: string
  repositoryId?: string
  worktreeId?: string
  repoPath?: string
}

interface MdviewHost {
  readText(file: FileCoordinate): Promise<string>
  readImage(file: FileCoordinate): Promise<string>
  resolveHref(href: string, source: FileCoordinate): Promise<ResolveFileRefResult>
  openFile(file: ResolvedFileRef): Promise<void>
  watchFile(file: FileCoordinate, onChange: () => void): Promise<() => void>
}
```

This affects Markdown document state keys, panel ids, pending fragments, explorer roots, image resolution, and watch keys. Those maps currently key by absolute path string. A serialized coordinate key is needed before changing the port types.

`@hafley66/signals` can hold these values and derived relations. Native side effects still enter through host functions or command adapters.

## Change surfaces in Instant

| Area | Files | Data affected |
| --- | --- | --- |
| Reference grammar | `src/termTokens.ts`, `src/refResolve.ts`, tests | line/column, punctuation, URI/revision classification |
| Click request context | `src/0_clickRouter.ts`, `src/terminal.ts`, `src/clickrules.ts` | session id, pane id, cwd observation, source document coordinate |
| Dynamic cwd observation | `src-tauri/src/pty.rs`, `src/worktrees.ts`, `src/terminal.ts` | per-pane current cwd and timestamps |
| Git identity | `src-tauri/src/worktrees.rs` or a Soopy adapter | repository id, worktree id, canonical root, repo-relative cwd |
| Cross-worktree relation | `src/worktrees.ts`, `src/0_settings.ts` or native store | touched worktrees grouped by repository id |
| Candidate search | `src/refResolve.ts`, `src-tauri/src/fs.rs` or Soopy search | repository-relative hits projected to eligible checkouts |
| Markdown coordinates | `packages/md/src/ports.ts`, `open.ts`, `signals.ts`, `MdPanel.tsx`, `MdExplorer.tsx` | document identity, relative href base, cache/watch keys |
| Preview coordinates | `src/preview.ts`, `src/fsWatch.ts`, dock restore state | open placement and revision provenance |
| Generated IPC | `ipc/commands.json`, generated native bindings | typed command request/results |

## Sequencing constraints

1. Add pane identity and current-cwd observation without changing file resolution. This establishes which cwd a click belongs to.
2. Add repository/worktree identity to `worktree_at` or a new location command. Persist session relations by ids while retaining absolute roots for display/migration.
3. Introduce `ParsedFileRef`, `LocationContext`, and `ResolvedFileRef` at the click-router boundary. Keep the existing resolver behind the interface during migration.
4. Return provenance and coordinates from current-worktree resolution.
5. Add repository-sibling candidate expansion using touched `WorktreeId` values sharing `RepositoryId`.
6. Change Markdown and preview panel identity from raw path keys to serialized coordinates where cross-worktree/revision retention is required.
7. Add revision-qualified reference syntax only after mutable worktree coordinates are carried end to end.

Tests at each boundary can use inline snapshots containing the complete parsed request, captured location, ordered candidate set, selected provenance, and opened coordinate. Cwd transition fixtures need at least: initial repo root, subdirectory, linked worktree outside scan roots, multiple panes, removed worktree, and return to a previously touched worktree.

## Open policy decisions

The following behavior requires explicit selection before implementation:

- Whether a relative reference emitted before a later `cd` resolves against output-time cwd or click-time cwd.
- Whether repository-sibling lookup is automatic, candidate-only, or limited to worktrees touched by the same agent session.
- Ordering among current cwd, current worktree, producing worktree, touched siblings, main checkout, and every linked checkout.
- Whether a dirty worktree file reference retains `RevisionId::Worktree` observation data or only `WorktreeId + RepoPath` placement.
- Whether Markdown links remain document-relative regardless of focused terminal cwd.
- Whether plain text and inline code inside rendered Markdown participate in command-click.
- Whether directory references, extensionless files, `file://` URLs, GitHub-style `path#L12`, compiler spans, and revision-qualified references share one parser grammar.
- Whether restored panels reopen the current mutable placement or the revision-qualified bytes originally opened.

## Existing behavior that can be reused

- Pointerup activation and drag cancellation in `CmdClickGestureTracker`.
- Ordered route registration and routed-event observation in `CmdClickRouter`.
- `tabCwds` as an initial full-session cwd set.
- tmux `pane_current_path` collection in the Rust PTY layer.
- `sessionWorktrees` as migration input for touched-checkout relations.
- `worktree_at` handling of checkouts outside configured scan roots.
- Soopy `RepositoryId`, `WorktreeId`, `RepoPath`, `RevisionId`, and `SourceRef` serialization contracts.
- Markdown's single host boundary and document-relative link handling.
- `@hafley66/signals` for reactive current-location, resolution, and document state.

