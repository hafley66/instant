# CONTRACT: quote-aware hover links (paths with spaces)

Base sha: a35ad6a. FIRST action: `git merge --ff-only a35ad6a` (must be a
no-op; STOP AND REPORT on failure). Never spawn subagents. No push. Commit
on this branch (lab/quotelink) only. Deliverable = REPORT.md at this
worktree root.

## Defect (user report + screenshot evidence)
Hovering `'/var/folders/.../Screenshot 2026-08-03 at 10.05.13 AM.png'` in a
terminal underlines only `/var/folders/.../Screenshot` — the underline stops
at the first space. Quoted paths with spaces cannot be opened.

## What the coordinator already verified (do not re-litigate, DO re-verify)
- `src/termTokens.ts` scanLineTokens (lines 93-112) ALREADY has a
  quoted-span pass: the (['"`])(.+?)\1 matchAll, and quoted spans suppress
  inner `\S+` runs. So the defect is not "no quote handling".
- `looksOpenable` (src/terminal.ts:259) passes space-containing paths (they
  carry `/`). Not the filter.
- Link provider: terminal.ts:548-579 -> wrappedLinkSpans
  (src/termWrapJoin.ts:83-91) -> scanLineTokens over the JOINED logical
  line. Join walks xterm isWrapped flags.

## Hypotheses to verify (in order; instrument, don't guess)
1. The failing line was the Claude Code TUI composer row. If the TUI
   re-renders its input box writing each visual row as its own line (no
   xterm hard-wrap flag), the joined line ends before the closing quote,
   the quote regex finds no pair, and the `\S+` fallback token
   `'/var/...Screenshot` gets LEAD-stripped and underlined. That output
   matches the screenshot exactly (underline starts at `/`, not at `'`).
2. Prose apostrophes false-pair: a line like
   `reading claude's log at '/a b/c.png'` pairs `'s ... '` first and
   destroys the real span. Non-greedy makes the first apostrophe an opener.
3. The hover card path (terminal.ts:380-382 wordAt/tokenAtColumn and the
   mousemove handler ~:591) may disagree with the underline path.

## Required behavior after fix
- A quoted path with spaces fully inside one joined logical line:
  underline + hover card + cmd-click dispatch the FULL inner path.
- Apostrophe-in-prose lines still link their unquoted tokens correctly and
  do not create bogus spans (fixture: the line in hypothesis 2).
- An UNPAIRED opening quote (close quote not in the joined line): no
  regression vs today; do NOT dispatch a truncated path as if complete. If
  you find a sound way to link composer-wrapped quoted paths, take it;
  if not, document why in REPORT.md and leave that case alone.

## Style laws (repo)
- One scanner owns span boundaries (termTokens.ts header comment). Fix in
  the scanner, not per call site.
- Comments state only constraints the code cannot show.
- New fixtures in src/termTokens.test.ts / termWrapJoin.test.ts, including
  the EXACT screenshot line. Fail-first: commit order shows red then green,
  or REPORT shows the pre-fix failing run.

## Gates (all must pass, output pasted in REPORT.md)
- npx tsc --noEmit
- npx vitest run src/termTokens.test.ts src/termWrapJoin.test.ts
- full: npx vitest run
- Playwright e2e only if an existing spec covers link hover; do not build
  new e2e infra.

## REPORT.md sections
verified-hypothesis (with instrument output) / fix summary / fixtures
added / gate outputs / unpaired-quote decision.
