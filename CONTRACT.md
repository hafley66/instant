# CONTRACT: message bus (queue + passing + ack) with queue-preview view

Base sha: a35ad6a. FIRST action: `git merge --ff-only a35ad6a` (must be a
no-op; STOP AND REPORT on failure). Never spawn subagents. No push. Commit
on this branch (lab/busmail) only. Deliverable = REPORT.md at this
worktree root.

## Ruling (the design authority, do not re-litigate)
2026-08-03-bus-ack-ruling.md at this worktree root. Envelope, ack
semantics, relational state are all fixed there. Apply it from the first
line: the mailbox NDJSON is the log, to_timestamp updates are APPENDED as
ack rows (append-only, latest row per id wins), ack = cass finds the
message in the recipient session's transcript, at-least-once resend is
safe, no separate receipt channel ever.
Build-vs-buy is settled by the ruling: the queue is an NDJSON file on the
OS filesystem, the ack reader is cass (already shelled to by
src-tauri/src/ledger.rs), tmux is the injection transport. No new queue
library, no new daemon.

## Existing pieces (verify, then reuse)
- src/plugins/harnessTrace/0_mail.ts + 0_mail.test.ts: mailbox fixtures
  from the dock-strip lab, single `ts` field PREDATES the ruling; its
  MailEnvelope type is optional-field tolerant (ruling scope note). You
  own these files; migrate them to the ruled envelope.
- src/plugins/harnessTrace/3_router.ts (50 lines): per-terminal view
  stack; how a preview view gets pushed.
- Registry join (agent id -> harness + session id): the same join the
  harness-trace rows use.
- cass CLI: `cass search "<id or body prefix>" --robot` scoped to the
  recipient's session/source path; `cass index --watch` freshness lever.

## Deliverables
1. Mail store: append envelope, list per agent id (in/out), ack state
   derived by latest-row-per-id fold. Pure sync functions over parsed
   rows; file IO and cass at the edges. Interface IMailStore.
2. Send leg (`hail`): append envelope + inject body into the recipient
   session. Implement the TMUX leg only (send-keys to the session the
   registry maps the agent id to). A recipient with no tmux pane = message
   stays queued, to_timestamp null. Do NOT invent injection for claude
   jsonl sessions; report it as the known-missing leg.
3. Ack sweep: for unacked messages, run the cass query; on hit, append
   the ack row with to_timestamp. Manual/poll trigger is fine; no daemon.
4. MailPreview view: NEW component rendering one agent id's queue —
   in/out, kind, reply_to threading, body preview, acked/unacked (show
   from_timestamp/to_timestamp), fed by IMailStore. Register it as a view
   in 3_router.ts so any caller can push it with an agent id.
5. The tree-table action itself (a row action in HarnessTracePanel.tsx
   that pushes MailPreview) is OWNED BY ANOTHER LANE's file. Do not edit
   HarnessTracePanel.tsx, InTabStrip.tsx, or src/main.ts. Instead put the
   exact patch (unified diff, few lines) in REPORT.md for the coordinator
   to apply at merge.

## File ownership (two other lanes are live in this repo)
- Yours: 0_mail.ts, 0_mail.test.ts, all NEW files (mail store, MailPreview,
  tests), this worktree only.
- Shared append-only: 0_types.ts and 3_router.ts — ADD lines at the end,
  never reorder or rewrite existing lines (another lane appends too;
  coordinator merges the union).
- Forbidden: HarnessTracePanel.tsx, InTabStrip.tsx, src/main.ts.

## Style laws (repo)
- Interfaces in the plugin's 0_types.ts, `I` prefix; important functions
  interface-bound, never bare export function.
- Async becomes rxjs; sync stays sync. Promise/async banned above the IO
  seam; in-memory folds are plain array code. Exactly ONE manual
  .subscribe() per app (baseline main.ts holds it; you add none).
- Comment budget: constraints only. Frozen clock
  (page.clock.setFixedTime) in any e2e rendering relTime.
- Colocated consistency: follow each touched file's existing style.

## Gates (outputs pasted in REPORT.md)
- npx tsc --noEmit
- npx vitest run src/plugins/harnessTrace
- full: npx vitest run
- A live round-trip receipt: send a hail to a scratch tmux session you
  create yourself (never an existing one), show the injected line in the
  pane, run the ack sweep, show to_timestamp filled. Kill your scratch
  session after. Paste the transcript.
- PNG of MailPreview over fixture messages (path in REPORT.md).

## REPORT.md sections
envelope migration diff / send-leg transcript / ack-sweep transcript /
missing-legs list (claude injection etc.) / HarnessTracePanel patch for
coordinator / gate outputs / PNG path.
