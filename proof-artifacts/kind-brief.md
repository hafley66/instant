# proof-kind lane brief

Repo: /Users/chrishafley/projects/instant-handoff. Package manager: pnpm (never
npm install; node_modules is already installed, install nothing). No commits,
no pushes. If reality deviates from this brief, STOP and report the deviation
in your final message; do not improvise.

Files you OWN (edit ONLY these four):
- src/plugins/harnessTrace/0_tree.ts
- src/plugins/harnessTrace/0_mail.ts
- src/plugins/harnessTrace/0_tree.test.ts
- src/plugins/harnessTrace/0_mail.test.ts

## The defect (context, verified by the coordinator)
Peer HAIL envelopes (kind "request"/"result"/"note") currently create dispatch
edges and why/from chips, because every "oldest envelope to X" loop ignores
envelope kind. A coordinator that merely received a report hail renders as a
child of the sender. Only kind "dispatch" envelopes may create lane edges.

## Change 1: 0_tree.ts, function resolveDispatchParents
In its oldest-first loop that fills `bySession`, skip any envelope whose
`kind` is anything other than "dispatch" (one added condition).

## Change 2: 0_mail.ts, function enrichRows
Same one-condition skip in its loop that fills `dispatchBySession`.

## Change 3: 0_mail.ts, function registrySeeds
In the loop that fills `dispatchFrom` (already skips froms missing from the
directory), also skip envelopes whose kind is anything other than "dispatch".
DO NOT touch the `lastMailMs` loop above it: activity grading keeps counting
every kind.

## Change 4: fail-first tests
Add these tests (write them to fail against the current code in your head,
then confirm they pass after your changes):
1. 0_tree.test.ts: an envelope with kind "request" from a registered sender to
   a registered session must NOT set parentId; the node stays a root.
2. 0_mail.test.ts (describe enrichRows): when the only envelope to a session
   has kind "result", the row gets from "user" and why "".
3. 0_mail.test.ts (describe registrySeeds): an envelope with kind "note" from
   a registered agent must leave parentId null AND still count for activity
   (a fresh "note" to a live-tmux route grades status "live").
Copy the existing fixture styles in each file. Comments: at most 2 consecutive
comment lines, stating only what the code cannot show. No em dashes anywhere.

## Validation (run these, all must pass, paste tails in your final message)
- npx vitest run src/plugins/harnessTrace
- npx tsc --noEmit
