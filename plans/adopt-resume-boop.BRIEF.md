# adopt-resume-boop (sol6)

**Goal:** harness resume commands start through `boop tui`, so an adopted session registers with boop and appears in the summon panel.

**Cause:** adopt (`src/worktrees.ts:301`) runs `adapter.resume(id)`, for example `claude --resume <id>`, inside tmux without the user's profile. The `claude()` shell function from `boop shell-init bash` is therefore never defined, and the bare binary starts unregistered.

**Files:** `src/0_harnessDefinitions.ts` and `src/0_harnessDefinitions.test.ts` only.

## Change
- Every harness that `boop shell-init bash` wraps (claude, codex, kimi, omp, opencode) gets a `resume` of the form `boop tui <harness> --bin <bin> -- <original resume args>`, using the same shape as boop's `boop_wrap`:
  - claude: `boop tui claude --bin claude -- --resume <id>`
  - codex: `boop tui codex --bin codex -- resume <id>`
- Keep the session id quoting the file uses today (`shellWord` if present).
- Leave non-resume commands (new-session launch, `opencode run`) unchanged.
- Run `boop tui --help` first. If `--bin` or `--` differ from this, match the help output and report the difference.

## Tests
- Update the existing snapshot or inline expectations in `0_harnessDefinitions.test.ts` for each changed resume.
- Add one case per wrapped harness, as inline snapshots.
- No `toBeDefined`, no `.skip`, no casts.

## Validation
`npx tsc --noEmit` shows 0 errors, and `pnpm exec vitest run src/0_harnessDefinitions.test.ts src/worktrees` passes.

## Commit
Subject exactly: `fix(adopt): resume harness sessions through boop tui`

Receipt: status / sha / files / validation / next.
