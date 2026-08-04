# registry-cas lane brief

Repo: /Users/chrishafley/projects/instant-handoff. Package manager: pnpm (never
npm install; node_modules already installed, install nothing). No commits, no
pushes. If reality deviates from this brief, STOP and report the deviation in
your final message; do not improvise.

Files you OWN (edit or create ONLY these four):
- scripts/0_atomicJson.ts (new)
- scripts/0_atomicJson.test.ts (new)
- scripts/bus.ts
- vitest.config.ts

Context (ruled by fable-main m-3b530e5c, spec in
docs/2026-08-04-registry-sqlite-build-vs-buy.md "Concrete migration steps"):
registry.json gets lost updates and torn writes under concurrent bus commands.
Fix = optimistic CAS keyed on content hash + atomic rename. Two ruled
amendments: version check is a CONTENT HASH (never mtime), and a JSON parse
error is a LOUD abort (never silently return {} and never write {} back over
live routes).

## scripts/0_atomicJson.ts (new module, no import side effects)
Export exactly:

```ts
export class CorruptJsonError extends Error {}
export interface ICasOptions { retries?: number; afterRead?: () => void; }
export function casUpdateJson(
  path: string,
  mutate: (current: Record<string, unknown>) => Record<string, unknown>,
  options: ICasOptions = {},
): Record<string, unknown>;
```

Behavior of casUpdateJson:
1. Read the file. Missing file = start from {} with hash null. Present but
   invalid JSON = throw CorruptJsonError naming the path (loud amendment).
2. Hash the exact bytes read with node:crypto sha256 hex.
3. Call options.afterRead?.() (the test seam), then mutate(structuredClone of
   parsed) to get the next object.
4. Re-read + re-hash the file. Hash changed since step 2 (or file appeared
   when it was missing) = another writer landed: retry from step 1, up to
   options.retries ?? 5 attempts, sleeping a jittered 1-20ms between tries
   (Atomics.wait on a SharedArrayBuffer, same trick as bus.ts sleepSync).
   Retries exhausted = throw a plain Error saying casUpdateJson gave up.
5. Write JSON.stringify(next, null, 2) + "\n" to
   `${path}.tmp-${process.pid}-<random>` in the SAME directory, then
   renameSync onto path (atomic on one filesystem). mkdirSync the parent
   with recursive true before writing. Unlink the temp file in a finally if
   the rename never happened.
6. Return the committed object.

## scripts/bus.ts
1. Import casUpdateJson + CorruptJsonError from "./0_atomicJson".
2. readRegistryRaw: keep "missing file = {}", but on JSON.parse failure STOP
   returning {}: print `registry.json is invalid JSON at <path>: fix or
   remove it by hand` to console.log and throw CorruptJsonError. Wrap the
   four command entry points? NO: instead, at the single bottom dispatch
   (`process.exit(commands[command](args))`), wrap the call in try/catch:
   CorruptJsonError = print the error message and process.exit(1).
3. mergeRoute body becomes one casUpdateJson call per migration step 2
   (registry[laneId] = route). Callers keep their signatures.
4. prune's read + writeFileSync pair becomes one casUpdateJson call per
   migration step 3 (delete dead names inside the mutate). Keep prune's
   existing console.log output identical.
5. No other behavior changes. hail/sweep/list read paths stay as they are.

## scripts/0_atomicJson.test.ts (vitest, node env, real fs in a mkdtemp dir)
Test cases, each in its own it():
1. happy path: missing file, one casUpdateJson writes a key, file content
   round-trips, no .tmp- file remains in the dir.
2. concurrent CAS (migration step 4, MUST prove the retry): writer A calls
   casUpdateJson with an afterRead hook that synchronously performs a
   SECOND casUpdateJson (writer B adding key "b") before A's mutate returns
   key "a". Assert the final file contains BOTH keys and A's return value
   contains both.
3. corrupt file: write "not json" to the path first; casUpdateJson throws
   CorruptJsonError and the file bytes are UNCHANGED afterward.
4. retries exhausted: afterRead hook rewrites the file with fresh content
   every time; with retries: 2 assert it throws the gave-up Error.

## vitest.config.ts
Add "scripts/**/*.test.ts" to test.include. Touch nothing else in the file.

Comments: at most 2 consecutive comment lines, stating only what the code
cannot show. No em dashes anywhere in prose or code.

## Validation (run all, paste tails in your final message)
- npx vitest run scripts src/plugins/harnessTrace
- npx tsc --noEmit
- Manual receipt (migration step 5): with a scratch dir
  `MD=$(mktemp -d)`, run two `node scripts/bus.ts adopt --name a1 --tmux
  <any-live-tmux-name> --harness shell --mail-dir $MD` style commands with
  DIFFERENT --name values back to back (pick a live tmux name from `tmux
  list-sessions -F '#{session_name}' | head -1`), then cat $MD/registry.json
  and confirm both names present. Paste the output.
