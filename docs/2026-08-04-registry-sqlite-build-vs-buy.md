# registry.json write race: build-vs-buy record

Scope: `~/.agent/mail/registry.json` (agent id -> `{sessionId, harness, tmux, cwd,
model, mode, sourcePath}`) has a lost-update race. Multiple concurrent
`node scripts/bus.ts` processes (`dispatch`/`resolve`/`adopt`/`prune`) each do
read-whole-file, mutate in memory, write-whole-file with no locking and no
compare-and-swap. `bus.ndjson` is append-only (`scripts/bus.ts:67-70`,
`appendFileSync` only) and is out of scope; every append site
(`hail`, `dispatch`, `sweep`) already avoids this class of race.

## Contents

1. [Current state, with receipts](#current-state-with-receipts)
2. [Why sqlite changes the write shape, not just the storage format](#why-sqlite-changes-the-write-shape-not-just-the-storage-format)
3. [Candidate 1: node:sqlite](#candidate-1-nodesqlite)
4. [Candidate 2: better-sqlite3](#candidate-2-better-sqlite3)
5. [Candidate 3: sqlite3 CLI shell-out](#candidate-3-sqlite3-cli-shell-out)
6. [Candidate 4: JSON + advisory lock](#candidate-4-json--advisory-lock)
7. [Candidate 5: JSON + atomic compare-and-swap](#candidate-5-json--atomic-compare-and-swap)
8. [Frontend read path impact by candidate (not scored)](#frontend-read-path-impact-by-candidate-not-scored)
9. [Scorecard](#scorecard)
10. [Recommendation](#recommendation)

## Current state, with receipts

Writers, all in `scripts/bus.ts`:

| site | file:line | what it does |
|---|---|---|
| `readRegistryRaw` | `scripts/bus.ts:90-98` | `JSON.parse(readFileSync(path))`, catches a parse error by returning `{}` (silent) |
| `mergeRoute` | `scripts/bus.ts:107-113` | reads whole registry via `readRegistryRaw`, sets one key, `writeFileSync`s the whole object back at line 112 |
| `dispatch` | `scripts/bus.ts:171-172` | calls `mergeRoute` after `tmux new-session` |
| `resolve` | `scripts/bus.ts:187-188, 218` | reads raw registry at 188 to find the route, calls `mergeRoute` at 218 to add `sessionId` |
| `adopt` | `scripts/bus.ts:413-420` | calls `mergeRoute` |
| `prune` | `scripts/bus.ts:425-437` | does not go through `mergeRoute`: reads raw registry itself at line 432, filters dead tmux sessions, `writeFileSync`s directly at line 435 |

Four independent read-modify-write cycles on the same file, two different code
paths (`mergeRoute` and `prune`'s inline block). A `dispatch` to lane A racing
a `prune` (or a second `dispatch` to lane B) is a real lost update: whichever
process's `readFileSync` snapshot is older loses whatever the other process
already committed, because the whole object is round-tripped through memory
and overwritten wholesale.

`readRegistryRaw`'s catch block (`scripts/bus.ts:93-97`) returns `{}` on a
parse error instead of surfacing it. A torn write (the writer process killed
mid-`writeFileSync`) truncates the file into invalid JSON; the next reader
silently sees an empty registry and the next writer commits that empty
registry back, wiping every live route. This has not been observed but is a
structural consequence of whole-file overwrite with no atomic rename.

Existing shell-out precedent, also in `resolve()` (`scripts/bus.ts:206-213`):

```
const db = join(homedir(), ".local/share/opencode/opencode.db");
const query = `SELECT id FROM session WHERE directory = '${cwd.replace(/'/g, "''")}' AND time_archived IS NULL ORDER BY time_created DESC LIMIT 1`;
const result = run("sqlite3", [db, query]);
```

Comment at `scripts/bus.ts:199-201` already documents the constraint this
candidate set inherits: "the sqlite3 CLI has no bind params, so a literal is
escaped by doubling the quote." A NUL-byte guard at `scripts/bus.ts:202-205`
exists because NUL cannot survive argv. This is a read-only query today; a
write candidate reuses the same escaping discipline but needs it applied to
every string field of every route (`harness`, `tmux`, `cwd`, `model`, `mode`,
`sessionId`, `sourcePath`), not just `cwd`.

Frontend read path (read-only, out of process from `scripts/bus.ts`):

- `src/plugins/harnessTrace/2_mailbox.ts:15-36` `MailboxReader.read(dir)`
  calls `invoke("list_dir", { path: dir })`, then `invoke("read_text", { path:
  entry.path })` per file (lines 16-24), including `registry.json`, and hands
  the text to `MailDirectory.parse` at line 30. Whole thing wrapped in a
  `.catch(() => ({ messages: [], directory: {} }))` at line 35, so a parse
  failure degrades to an empty directory, not a crash.
- `src/plugins/harnessTrace/0_bus.ts:186-220` `MailDirectory.parse` is a pure
  string-to-object parser: `JSON.parse` wrapped in try/catch (lines 188-193,
  returns `{}` on failure), tolerant of a bare-string legacy shape (line
  198-201) and of the full route-object shape (lines 202-213).

Rust: no rust code touches `~/.agent/mail/registry.json`. Grep for
`registry.json`, `bus.ndjson`, and `.agent/mail` across `src-tauri/src/*.rs`
returns nothing. The only rust hits for the bare word "registry" are
`src-tauri/src/workspace.rs:3,31,34` (`workspaces.json`, an unrelated
persisted-Spaces list) and a struct-field comment at `src-tauri/src/harness.rs:150`.
The IPC commands the frontend calls, `fs::list_dir` (`src-tauri/src/fs.rs:70`)
and `fs::read_text` (`src-tauri/src/fs.rs:363`), are generic filesystem
primitives with no registry-specific code in rust.

Rust does already carry `rusqlite = { version = "0.32", features = ["bundled"]
}` (`src-tauri/Cargo.toml:30`), used two ways today: read-only against other
harnesses' own session databases (`src-tauri/src/harness.rs:69-71,370-372`,
opened with `SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_NO_MUTEX`), and as an
owned, written-to store for favorites (`src-tauri/src/favorites.rs:16-60`:
`favorites.db` in `app_data_dir`, schema at lines 42-47, `init()` opens and
creates the table idempotently). This lowers the cost of a *new IPC command*
for a sqlite-backed registry (mirror `favorites.rs`'s pattern) but does not
touch the writer side, since the writer is `scripts/bus.ts`, a plain node
process outside the tauri app.

Node version: `node --version` in this environment is `v24.15.0`. `package.json`
has no `"engines"` field and no `.nvmrc` pinning that.

## Why sqlite changes the write shape, not just the storage format

Every JSON writer above follows the same pattern: read the whole file, mutate
one key (or filter several) in memory, write the whole file back. That shape
is what creates the race, and it is not intrinsic to having many writers.

Registry writes are naturally per-key: `mergeRoute(dir, laneId, route)` only
ever touches one row. That maps directly onto a SQL `INSERT OR REPLACE INTO
routes (lane_id, harness, tmux, cwd, model, mode, session_id, source_path)
VALUES (...)`, with no read-before-write step at all, for any of the three sqlite
candidates. `prune()` still needs a multi-row read (`SELECT lane_id, tmux FROM
routes`) followed by targeted `DELETE`s, but SQLite's own transaction and file
locking (POSIX advisory locks via `fcntl`, local disk under `~/.agent/mail`,
no NFS involved) serializes that against concurrent single-row upserts from
other processes: there is no "read snapshot of everything, write everything"
step left to race.

Confirmed on this machine: `PRAGMA busy_timeout` is honored by `node:sqlite`
(`db.exec('PRAGMA busy_timeout = 5000')`, verified against a live
`DatabaseSync` instance) and is the standard knob for all three sqlite
candidates: without it, a writer that finds the db locked fails immediately
with `SQLITE_BUSY` instead of blocking and retrying.

## Candidate 1: node:sqlite

**Mechanics.** Node builtin (`node:sqlite`, `DatabaseSync`/`StatementSync`).
No `package.json` change, no install step. `scripts/bus.ts` already runs
under plain `node` with type stripping (header comment, `scripts/bus.ts:5-6`;
confirmed empirically: `node scripts/bus.ts list --mail-dir <dir>` runs with
zero flags on this Node 24.15.0). Import is `import { DatabaseSync } from
"node:sqlite"`, unaffected by type stripping since it is ordinary module
resolution, not TS syntax.

Version and stability, confirmed by web search:

- Flag requirement dropped in Node 22.13.0 and 23.4.0 (`--experimental-sqlite`
  no longer needed): [nodejs/node@55239a4](https://github.com/nodejs/node/commit/55239a48b6).
- On Node 24.x the module carries **Stability: 1.1 - Active development**
  (the higher "1.2 - Release candidate" label only appears starting v26.x, per
  the fetched docs for v26.6.0). "Active development" is Node's own language
  for "API may still change between semver-minor releases."
- Repo has no `"engines"` field pinning a minimum node version, so a
  contributor on Node <22.13 would hit a hard `ERR_UNKNOWN_BUILTIN_MODULE`.

**Failure modes.**

- No bind-params problem: `db.prepare(...).run(...)` takes real parameters,
  unlike the sqlite3-CLI candidate, so no manual SQL-escaping helper is
  needed anywhere (removes the escaping burden documented in the receipts
  section, not just avoids adding to it).
- API surface is younger than `better-sqlite3`'s; "Active development"
  stability means a semver-minor Node bump could change behavior under this
  script with no changelog entry in this repo's own history to catch it.
- `DatabaseSync` is synchronous, matching `scripts/bus.ts`'s current fully
  synchronous style (no `async`/`await` needed anywhere in the file today),
  a genuine fit, not just a coincidence.

**Migration cost, node writer.** Replace `readRegistryRaw`/`mergeRoute`/
`prune`'s inline block with a small module: open (or create) `registry.db`
next to `registry.json`, run a `CREATE TABLE IF NOT EXISTS routes (lane_id
TEXT PRIMARY KEY, harness TEXT, tmux TEXT, cwd TEXT, model TEXT, mode TEXT,
session_id TEXT, source_path TEXT)` once, then rewrite the four call sites as
prepared-statement upserts/deletes. `readDirectory` (`scripts/bus.ts:45-48`,
used read-only by `hail` and `sweep`) becomes a `SELECT *` mapped into the
same `IMailDirectory` shape `MailDirectory.parse` already returns, so callers
of `readDirectory` do not change signature.

**Migration cost, frontend read path.** `MailDirectory.parse` today parses a
JSON *string* (`0_bus.ts:187-215`); it cannot parse sqlite bytes. Two options,
neither free:
1. New tauri IPC command that opens `registry.db` read-only with `rusqlite`
   (mirrors the read-only pattern already at `src-tauri/src/harness.rs:69-71`)
   and returns rows as JSON, replacing the `invoke("read_text", ...)` call for
   this one file in `2_mailbox.ts:19-24`. `MailDirectory.parse` then goes away
   or becomes a thin JSON-array mapper instead of a JSON-object mapper.
2. Keep `registry.json` as a generated projection: every writer-side upsert
   also writes the plain JSON file (or a periodic export). Zero rust/IPC
   change, but now two representations to keep in sync and the projection
   write reintroduces a smaller version of the original race (though now
   single-writer-at-a-time if the db write already serialized them, so it
   degrades to "eventually correct," not "lost update").

**Verdict.** Best mechanical fit for the node writer (zero deps, sync API,
built-in escaping via bind params) with the least certain stability floor;
the "Active development" label and missing `engines` pin are the real costs,
not the mechanics.

## Candidate 2: better-sqlite3

**Mechanics.** Native addon (`npm i better-sqlite3`), synchronous API
(`db.prepare(...).run(...)`), the most mature and widely deployed node sqlite
binding. Latest published version confirmed via npm registry: `13.0.2`,
`engines.node: ">=22"`.

**Failure modes, install/build cost.**

- New direct dependency in `package.json`, unlike the other two sqlite
  candidates.
- Prebuilt-binary coverage has lagged new Node majors before: `better-sqlite3`
  v12.0.0 shipped without a prebuilt binary for Node 24's N-API version 137,
  producing a 404 on install and forcing a `node-gyp` source build
  ([WiseLibs/better-sqlite3#1384](https://github.com/WiseLibs/better-sqlite3/issues/1384)).
  By `13.0.2` (current latest) this specific gap is presumed closed given the
  `engines.node >= 22` claim, but the pattern (prebuild lag on a new Node
  major) is the recurring failure mode for every native-addon candidate, not
  a one-time bug.
- When a prebuilt binary is missing, macOS ARM64 users specifically have hit
  "No prebuilt binaries found (target=... runtime=node arch=arm64 ...
  platform=darwin)" ([WiseLibs/better-sqlite3#1027](https://github.com/WiseLibs/better-sqlite3/issues/1027)),
  falling back to `node-gyp`, which needs Xcode command-line tools and a C++
  toolchain present on the machine, not guaranteed on every box that runs
  `bus.ts` (this script is explicitly meant to run outside the tauri app,
  potentially on a bare CLI host).
- `scripts/bus.ts` runs under plain `node` with type stripping, not through
  any bundler, and a native `.node` binary import works fine here (module
  resolution is untouched by type stripping), so this is not a blocker, just
  noted because it is the thing type stripping could plausibly have broken
  and does not.

**Migration cost, node writer.** Same shape as candidate 1 (schema, four
call sites rewritten to prepared statements), swapping `import { DatabaseSync
} from "node:sqlite"` for `import Database from "better-sqlite3"`. Marginally
more mature error messages and a `.pragma('busy_timeout = 5000')` convenience
method.

**Migration cost, frontend read path.** Identical to candidate 1: same two
options (new rust IPC command via `rusqlite`, or a maintained JSON
projection). `better-sqlite3` is a node-only binding; it does not change
anything about how rust would read the resulting db file, since rust would
use `rusqlite` regardless of which node library wrote it (both write standard
SQLite files).

**Verdict.** Most battle-tested API of the three sqlite candidates, at the
cost of being the only one that adds a native dependency with a real, cited
history of Node-major prebuild lag and macOS-arch build friction. Right
choice if the writer needs a more mature ecosystem (extensions, WAL-mode
helpers, TypeScript types) than `node:sqlite` currently offers; for a
single-table routes cache it does not need any of that.

## Candidate 3: sqlite3 CLI shell-out

**Mechanics.** No new dependency at all: `/usr/bin/sqlite3` is already present
on this machine (`sqlite3 --version` → `3.43.2 2023-10-10`), and
`scripts/bus.ts` already shells out to it in `resolve()`
(`scripts/bus.ts:206-213`) via the existing `run(bin, argv)` helper
(`scripts/bus.ts:72-80`, wraps `spawnSync`).

**Failure modes.**

- No bind params (documented in-repo already, `scripts/bus.ts:200-201`):
  every string field written needs the same `.replace(/'/g, "''")` treatment
  currently applied only to `cwd` in the `resolve()` query. That is seven
  fields (`harness`, `tmux`, `cwd`, `model`, `mode`, `sessionId`,
  `sourcePath`) across four call sites needing the escape applied
  consistently. A missed field is a SQL-injection-shaped bug (low severity
  here since inputs are CLI args and tmux/harness state the operator
  controls, but real: a `cwd` or `body`-derived value with an embedded quote
  that skips escaping breaks the statement or, worse, executes unintended
  SQL if multiple statements are ever batched in one `sqlite3` invocation).
- One process spawn per write (`spawnSync` cost measured elsewhere in this
  file already, e.g. every `tmux` and `cass` call). For the write rate this
  script sees (interactive dispatch/resolve/adopt/prune, not a hot loop) this
  is not a performance concern.
- `sqlite3` CLI version on this machine (3.43.2, from Oct 2023) is old enough
  that some newer SQL features are unavailable, though nothing this schema
  needs (`INSERT OR REPLACE`, `PRAGMA busy_timeout` are long-stable).
- Setting `busy_timeout` per invocation requires prefixing every write with
  `PRAGMA busy_timeout=5000;` in the same `sqlite3 db "..."` argument, since
  each shell-out is a fresh connection with no persisted pragma state.

**Migration cost, node writer.** Zero install cost, but the most application
code of the three sqlite candidates: a small `sqlEscape(value)` helper
generalizing the existing inline `.replace(/'/g, "''")`, applied to every
field, plus building `INSERT OR REPLACE INTO routes (...) VALUES ('...',
...)` strings by hand (no query builder, per the "zero new deps" constraint)
across `mergeRoute` and `prune`. This is strictly more hand-written SQL string
assembly than candidates 1 and 2, in exchange for zero new install-time risk.

**Migration cost, frontend read path.** Same as candidates 1 and 2 (new rust
IPC command via `rusqlite`, or a JSON projection). The CLI choice is entirely
a node-writer concern; it produces the same on-disk SQLite file format the
other two candidates would, so it does not change the read-side analysis at
all.

**Verdict.** Matches the file's existing style law most closely (this script
already shells out to `sqlite3` and to `tmux`/`cass`; "zero fs API surface,
only fs and spawn" is stated as the file's own design principle at
`scripts/bus.ts:3-4`) and adds no install risk, at the cost of hand-rolled SQL
string escaping across more call sites than the library-based candidates.

## Candidate 4: JSON + advisory lock

**Mechanics.** Keep `registry.json` as-is; wrap every read-modify-write
cycle (`mergeRoute`, `prune`'s inline block) in an advisory lock so only one
process's RMW cycle executes at a time.

Two concrete library options, researched separately because they use
different primitives:

- `proper-lockfile` (`moxystudio/node-proper-lockfile`): mkdir-based lock
  (an atomic `mkdir` as the lock acquire, safe on network filesystems too,
  per its own docs), with mtime-refresh staleness detection (default `stale:
  10000`ms, refreshed every `stale/2`) so a killed lock-holder's lock expires
  instead of deadlocking readers forever. **Async-only API** (`lock()`/
  `unlock()` return promises). Latest npm version `4.1.2`, published
  2021-01-25, no release in roughly five years, but 1,678 npm dependents per
  the registry, and the mechanism (mkdir) has no moving parts that go stale
  the way a native binding's Node-ABI compatibility does.
- `lockfile` (npm, by isaacs): `open()` with `O_EXCL` as the acquire
  primitive, and, notably, offers **`lockSync`/`unlockSync`**, a synchronous
  API that fits `scripts/bus.ts`'s current fully synchronous style without
  restructuring the file. Latest npm version `1.0.4`, published 2018-04-17,
  older and less actively maintained-looking than `proper-lockfile`, not
  deprecated.
- A raw `flock`-based approach (the literal ask in the brief) does not have a
  zero-dependency path on this machine: `which flock` returns nothing on this
  macOS box (confirmed: no `/usr/bin/flock`, `/opt/homebrew/bin/flock`, or
  similar; `man flock` only resolves to the section-2 C syscall, not a
  section-1 shell command). macOS ships the `flock(2)` syscall but not a
  `flock(1)` CLI (that is a util-linux tool, installable via `brew install
  util-linux` but not present by default). Reaching `flock(2)` from node
  without a CLI means either a native addon (same build-pain profile as
  `better-sqlite3`) or an FFI-based package. There is no path to "flock but
  zero new deps and zero build step" on this machine today.

**Failure modes.**

- A lock only prevents an *interleaved* RMW; it does not fix the silent
  `{}`-on-parse-error behavior at `scripts/bus.ts:93-97`. A process that
  crashes between acquiring the lock and finishing the write still produces
  a truncated file, and the next reader silently treats that as an empty
  registry. Locking and atomic-write are separate concerns; this candidate
  only buys the first one unless combined with candidate 5's
  temp-file-plus-rename.
- A stale lock (holder killed with the lock held, before the staleness
  window elapses) blocks every other writer until the `stale` timeout
  passes: a real availability cost the JSON-only candidates that skip
  locking do not have.
- `proper-lockfile`'s async API is a bigger structural change to
  `scripts/bus.ts` than any sqlite candidate: the file today ends with
  `process.exit(commands[command](args))` (`scripts/bus.ts:447`), calling
  every command function synchronously. Adopting an async lock means either
  converting the whole dispatch table to return promises and moving to a
  top-level `await`, or accepting the sync-only `lockfile` package instead
  specifically to avoid that restructuring.

**Migration cost, node writer.** Wrap `mergeRoute`'s body and `prune`'s
inline read+filter+write in `lockSync(lockPath)`/`unlockSync(lockPath)` (or
`await lock()/unlock()` if choosing `proper-lockfile`, with the async
restructuring noted above). No schema, no new file format: `registry.json`
stays JSON, so `readRegistryRaw` and the write-back `JSON.stringify(...)`
calls are unchanged; only a lock acquire/release wraps them.

**Migration cost, frontend read path.** None. `MailDirectory.parse`
(`0_bus.ts:186-220`) and `MailboxReader.read` (`2_mailbox.ts:15-36`) keep
reading a plain JSON file exactly as today. This is the only candidate with
zero frontend changes, because the on-disk format never changes.

**Verdict.** Cheapest frontend cost of any candidate (none) and smallest
conceptual diff from today's code, but does not address the torn-write /
silent-data-loss failure mode on its own, and the literal "flock" mechanism
named in the brief is not actually available zero-cost on this machine. The
real choice within this candidate is `lockfile` (sync, older, fits the
current file's sync style) vs `proper-lockfile` (async, more actively
depended-on, requires restructuring `scripts/bus.ts` to async).

## Candidate 5: JSON + atomic compare-and-swap

**Mechanics.** Keep `registry.json` as JSON, drop any lock file, and instead
make each writer's commit atomic and self-detecting:

1. Read the file, keep both the parsed object and either its `mtimeMs`
   (`fs.statSync(path).mtimeMs`) or a content hash (`crypto.hash("sha256",
   text)`) as the "version read."
2. Compute the new registry in memory (same as today).
3. Before committing, re-`stat` (or re-read) the file. If the version changed
   since step 1, another writer committed in between, so retry from step 1
   (bounded retry count with a short backoff, e.g. 5 attempts, jittered
   1-20ms).
4. Write the new content to a temp file in the same directory
   (`registry.json.tmp-<pid>-<random>`), then `fs.renameSync(tmp, path)`.
   POSIX `rename(2)` onto an existing destination is atomic on the same
   filesystem, so no reader ever observes a partially written file, which
   directly closes the torn-write / silent-`{}` gap that candidate 4 leaves
   open.

**Failure modes.**

- This is optimistic concurrency control: under real contention (a fan-out
  dispatching to many lanes near-simultaneously), writers retry rather than
  block, so no single stale-lock-holder can wedge every other writer the way
  candidate 4's advisory lock can. A busy period does produce visible retry
  churn (and, in the worst case with a low retry cap, a dropped write that
  logs a failure instead of silently corrupting data, which is a strictly
  better failure mode than today's silent overwrite).
  Every write still round-trips the whole file through memory, so this
  candidate does not remove the fundamental whole-file-RMW shape the way the
  sqlite candidates do. It only makes each individual round trip safe and
  detects collisions instead of silently losing them.
- mtime-based version checks have a real granularity floor: on some
  filesystems mtime resolution is coarser than the time between two very
  fast successive writes, which is why a content hash is the more robust
  choice of the two version-check options listed above, at a small extra
  read+hash cost per attempt.
- Needs the temp file cleaned up on the failure path (a crash between
  `writeFileSync(tmp, ...)` and `renameSync` leaves an orphan
  `registry.json.tmp-*` file); a simple mitigation is naming the temp file
  deterministically per-pid so a later run from the same script can detect
  and remove stale ones, or just letting them accumulate harmlessly in
  `~/.agent/mail` since they never get read by anything.

**Migration cost, node writer.** Wrap the existing `readRegistryRaw` +
mutate + `writeFileSync` shape in `mergeRoute` and `prune`'s inline block with
a small `casWrite(path, mutateFn)` helper (read, stat/hash, mutate, re-check,
temp-write, rename, retry-on-mismatch). No new dependency (`node:fs`,
`node:crypto` are builtins already imported or trivially added). This is the
smallest node-side code change of the five candidates: no schema, no new
process spawns, no new binding.

**Migration cost, frontend read path.** None, same as candidate 4: the file
stays JSON, `MailDirectory.parse` and `MailboxReader.read` are untouched. The
frontend's existing tolerance of a parse failure (`0_bus.ts:188-193` catch
returning `{}`, `2_mailbox.ts:35` catch returning an empty mailbox) is no
longer covering up a real torn-write bug, since the atomic rename means the
frontend will never observe a torn file in the first place. It becomes
pure defensive code against, for example, a user hand-editing the file badly.

**Verdict.** Directly targets both failure modes named in the problem
(lost update and torn write) with zero new dependencies and zero frontend
changes, at the cost of retry logic under contention that a lock-based or
sqlite-based approach does not need to reason about.

## Frontend read path impact by candidate (not scored)

| candidate | frontend change required |
|---|---|
| node:sqlite | new IPC command (rust `rusqlite` read) or a maintained JSON projection file |
| better-sqlite3 | same as node:sqlite, read-side cost is identical regardless of which node library wrote the db |
| sqlite3 CLI | same as node:sqlite, on-disk format is standard SQLite regardless of writer |
| JSON + lock | none, `registry.json` stays JSON |
| JSON + atomic CAS | none, `registry.json` stays JSON |

## Scorecard

| candidate | new install | build risk | solves lost update | solves torn write | frontend change | node writer diff size |
|---|---|---|---|---|---|---|
| node:sqlite | none (builtin) | low (stability 1.1, no engines pin) | yes (per-row upsert) | yes (sqlite journal) | new IPC or projection | medium (schema + 4 call sites) |
| better-sqlite3 | yes (native addon) | medium (cited Node-major prebuild lag, macOS arm64 fallback to node-gyp) | yes | yes | new IPC or projection | medium |
| sqlite3 CLI | none (system binary, already shelled out to) | none | yes | yes | new IPC or projection | medium-large (hand-built SQL + escaping) |
| JSON + lock | yes (`proper-lockfile` or `lockfile`) | low (pure JS, but both packages are old) | yes, while locked | no, on its own | none | small, but async restructuring if using `proper-lockfile` |
| JSON + atomic CAS | none | none | yes, via retry | yes, via temp+rename | none | smallest |

## Recommendation

**Winner: candidate 5, JSON + atomic compare-and-swap.** It is the only
candidate that fixes both named failure modes (lost update and the
silent-`{}`-on-torn-write path at `scripts/bus.ts:93-97`) with zero new
dependencies, zero frontend/IPC change, and the smallest diff to
`scripts/bus.ts`. The sqlite candidates are mechanically cleaner (real
per-row upserts instead of a retry loop) but all three pay the same
frontend-side cost, a new rust IPC command or a projection file to keep in
sync, for a registry that is small, low-write-volume, and already fully
served by the existing JSON read path on the frontend. That cost is not
worth paying today; revisit sqlite if `registry.json` ever needs to be
queried (not just listed) from the frontend, or if write volume grows past
what a bounded retry loop handles cleanly.

Concrete migration steps (half-day budget):

1. Add `casWrite(path, mutateFn, { retries = 5 })` to `scripts/bus.ts` (or a
   new local module next to it): read + hash (`node:crypto`), call
   `mutateFn(parsed)` to get the new object, re-hash the file, retry on
   mismatch, else `writeFileSync` to `${path}.tmp-${process.pid}` and
   `renameSync` onto `path`.
2. Replace `mergeRoute` (`scripts/bus.ts:107-113`) with a call to
   `casWrite(registryPath, (registry) => { registry[laneId] = route; return
   registry; })`. Callers (`dispatch:172`, `resolve:218`, `adopt:414-420`)
   need no signature change.
3. Replace `prune`'s inline read (`scripts/bus.ts:432`) + `writeFileSync`
   (`scripts/bus.ts:435`) with `casWrite(registryPath, (registry) => {
   for (const name of Object.keys(registry)) if (!live.has(registry[name]?.tmux))
   delete registry[name]; return registry; })`.
4. Add a unit test (or extend `0_bus.test.ts`/a new `scripts/bus.test.ts` if
   one does not exist) that runs two `casWrite` calls concurrently against
   the same temp file with an injected delay between read and write, and
   asserts both keys survive (proves the retry path, not just the happy
   path).
5. Manually verify: run two `node scripts/bus.ts dispatch ...` invocations
   back-to-back against a scratch `--mail-dir`, confirm both lanes appear in
   the resulting `registry.json`.
6. No changes needed to `src/plugins/harnessTrace/0_bus.ts`,
   `2_mailbox.ts`, or any rust file. Leave them untouched and confirm with a
   diff that they are.
