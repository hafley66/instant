# CONTRACT: live spawn test — claude(sonnet) spawns opencode, states polled

Base: branch lab/livespawn at 57560ff (= a35ad6a + lab/tracetree +
lab/busmail, merged and green: plugin vitest 68/68). FIRST action:
`git merge --ff-only 57560ff` (must be a no-op; STOP AND REPORT on
failure). Never spawn subagents (the scratch harness sessions below are
the test SUBJECT, not delegation — they are allowed and required). No
push. Commit on lab/livespawn. Deliverable = REPORT.md at worktree root
(if the Write tool refuses it, return the content as text; never work
around the refusal).

## User words (scope law)
"is there a screenshot that shows a session of claude that just has a
'spawn an opencode agent etc.' and we are able to poll things for 1
minute at a time to see the states change. dont equality test things
that are prompts but we need a live test idc the cost just keep it cheap
and make sure claude code is started with sonnet as the model"

## The test (a script + spec runnable on demand; NOT in any default battery)
1. Scratch tmux server on its OWN socket (`-L livespawn-gate`), scratch
   cwd. Never address the default tmux socket (read-only `tmux -L default
   ls` proof allowed). Recipe proven in REPORT.md section 3 of this
   branch: env scrubbed of CLAUDE_CODE_*/CLAUDE* vars so the session is
   its own root.
2. Start claude IN THAT PANE with `--model sonnet` (hard requirement,
   cost control). Register it in a scratch registry.json (busmail
   scripts/bus.ts conventions; sourcePath resolved from
   ~/.claude/projects after boot).
3. `node scripts/bus.ts hail` it (kind `dispatch`) with a prompt that
   tells it to run ONE exact verbatim command spawning an opencode agent:
   `opencode run -m openrouter/deepseek/deepseek-v4-flash-0731 --auto
   "<one trivial sentence task>"` in the scratch cwd, then reply done.
   Sonnet executes, never composes, the command. Cheap models both legs.
4. Poll loop: up to 6 windows of <=60s (total budget <=6 min wall), each
   window samples every ~10s. Each sample records (a) the harness data
   states via the REAL readers (claude jsonl status, opencode.db row for
   the spawned session, bus.ndjson ack state), and (b) a PNG of the
   harness-trace tree page rendering THAT SAMPLE'S live data — parent
   claude row, opencode child under it (the dispatch edge comes from the
   hail row + registry), status column visible.
5. Assertions are on STRUCTURE and STATE TRANSITIONS ONLY: session rows
   exist, the child hangs under the parent via `dispatch`, status moves
   (live -> idle/done), ack to_timestamp fills after a sweep + targeted
   `cass index --watch-once`. NEVER assert equality on prompt/body text
   (user law). Relative times frozen or asserted structurally.
6. Teardown: kill the scratch tmux server; prove the default socket's
   sessions survived.

## Rendering live data in the page
The e2e harness drives the panel with seeds; the DATA in each sample must
be real harness output (real jsonl, real opencode.db rows, real
bus.ndjson) read at sample time — only the transport into the page may be
adapted (feeding the real files' parsed rows through the existing seed
seam is legitimate; fabricating rows is not). If no honest seam exists,
STOP AND REPORT which seam is missing instead of faking data.

## Laws
- 10-second law: this gate is a USER-NAMED EXCEPTION (live wall-clock
  test, on demand only). It must never enter green-all, vitest, or any
  default battery; wire it as its own script/config, document the run
  command in REPORT.md.
- File ownership: InTabStrip.tsx and src/main.ts are FORBIDDEN (a live
  lane owns them elsewhere). HarnessTracePanel.tsx and everything else in
  the worktree is yours.
- Style laws per repo: interfaces in 0_types.ts (append at end), comment
  budget, colocated consistency.

## Gates (outputs in REPORT.md)
- The live run transcript: hail output, poll samples with timestamps and
  states, sweep/ack receipt.
- PNG sequence paths (minimum 3 distinct states: parent alone; child
  present live; child done and/or ack filled) + which state each shows.
- npx tsc --noEmit (no new errors vs 57560ff), npx vitest run
  src/plugins/harnessTrace still green.
- Teardown proof.

## REPORT.md sections
run command / live transcript / PNG sequence with state captions /
assertion list (structure+transition only) / seams adapted vs real /
missing seams / gate outputs / teardown proof / cost note (models used).
