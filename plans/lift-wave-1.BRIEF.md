# lift-wave-1 (wave 1c, sol6): instant consumes lifted modules, originals deleted

Plan: ~/projects/hafley-rxjs/plans/boop-xterm-lift.PLAN.md. Read it. Read ~/projects/claude-research/skills/rxjs/SKILL.md.

## Package versions (local verdaccio, `@hafley66` scope already routes there via ~/.npmrc)
- `@hafley66/md@0.1.2-dev.1790388441671`
- `@hafley66/boop-xterm@0.0.1-dev.1790388441671` (new dependency)
- `@hafley66/trace@0.1.0-dev.1790388441671`
Exact pins, same style as the existing `@hafley66/*` entries in package.json.

## Step 0: baseline before any edit
Run `pnpm install --frozen-lockfile`, `npx tsc --noEmit`, `pnpm test` on the untouched base. Record failing test
files and tsc error count. These are pre-existing and do not block you. The receipt carries both baselines.

## Step 1: delete originals, rewire importers
| delete from src/ (with its *.test.ts) | importers now use |
| --- | --- |
| termTokens.ts | `@hafley66/boop-xterm` |
| 0_termCell.ts | `@hafley66/boop-xterm` |
| termWrapJoin.ts | `@hafley66/boop-xterm` |
| termBufferToken.ts | `@hafley66/boop-xterm` |
| 00_terminalTurnRegions.ts | `@hafley66/boop-xterm` |
| 0_terminalFonts.ts | `@hafley66/boop-xterm` |
| 0_terminalRowGeometry.ts | `@hafley66/boop-xterm` |
| 0a_terminalTurnMatching.ts | `@hafley66/boop-xterm` |
| 0_markdownTree.ts | `@hafley66/md` |
| 0_diagramRenderCache.ts | `@hafley66/md` |
| 0_d2Preview.ts | `@hafley66/md` |
| 0_svgViewport.ts | `@hafley66/md` (svg functions now live in md `lib/0_svgSurface.ts`, exported from the root) |

Types `BoopTurn`, `VisibleTurn`, `LogicalLine`, `HarnessId` now have one definition: `@hafley66/boop-xterm`.
The instant files that defined them (0_terminalTurnVisibility.ts, 00a_terminalIntersection.ts, harnessTypes.ts)
replace the definition with `export type { X } from "@hafley66/boop-xterm"`. Field names unchanged.
KEEP `0b_ompTurnBinding.ts` and its test in instant this wave.

Use `extract move`/`extract rename` where it applies (read `extract --help`; dry-run, inspect, then `--commit`).
Manual edits only where extract reports a gap.

## Gates (receipt carries each command and its result line)
1. `rg -l "termTokens|0_termCell|termWrapJoin|termBufferToken|00_terminalTurnRegions|0_terminalFonts|0_terminalRowGeometry|0a_terminalTurnMatching|0_markdownTree|0_diagramRenderCache|0_d2Preview|0_svgViewport" src` prints nothing.
2. `npx tsc --noEmit`: error count <= baseline, and no error in a file you touched.
3. `pnpm test`: failing test files is a subset of baseline failures.
4. `.subscribe(` count in src (non-test) is <= 74 (`rg -c '\.subscribe\(' src packages -g '!*.test.*' -g '!*.spec.*'`, summed).
5. No added `as any`, `@ts-ignore`, `@ts-expect-error`, `.skip(`, `.only(`, `toBeDefined`: `git diff <base>..HEAD | rg '^\+.*(as any|@ts-ignore|@ts-expect-error|\.skip\(|\.only\(|toBeDefined)'` prints nothing.

## Stop on
A lifted symbol missing from the package export (name it: package, symbol), a behavior difference surfaced by a test,
or any need to edit hafley-rxjs. Report and stop.

## Commits
`deps: @hafley66/boop-xterm and md dev pins from local verdaccio`, then `refactor: import lifted terminal pure layer from @hafley66/boop-xterm`,
then `refactor: import lifted md modules from @hafley66/md`.
Receipt: status / sha / files / validation / next.
