# Proof run: instant agent navigation + messaging

Run of 2026-08-04 18:39-18:58, against the RUNNING debug app (default tmux
socket, real ~/.agent/mail), frontend at instant main 8a419c5. Every PNG is the
whole app window; every claim below was verified by reading the PNG. Mid-run
code fixes forced two full restarts (DEFECTS.md); stage numbering below is the
final, passing run.

## Contents
- Stage table
- Grading criteria (m-17f56e54)
- Bonus receipts the run produced
- Known gaps and honest notes
- Artifact index

## Stage table

| NN | slug | action | expected | observed | artifact |
|---|---|---|---|---|---|
| 01 | baseline | none | app front, strip visible, no proof- rows | PASS: full window, strip = 1 external shell (b10a087f on tmux instant-fable), zero proof- rows | stage-01-baseline.png |
| 02 | dispatch | `bus dispatch --to proof-alpha2 --from instant-fable --cmd 'sleep 900'` | row appears with ZERO clicks, status live | PASS: count 1 -> 2 within 4s of the bus write, no clicks; lane nested under its dispatcher b10a087f on the GRANDPARENT coordinator's tab (sprefa-3) | stage-02-dispatch.png |
| 03 | hail-queued | `bus hail --to proof-scratch`, open its mail queue | envelope queued/unacked in MailPreview | PASS: MailPreview "3 messages · 1 unacked": two older acked rows, fresh hail m-df687744 shows queued | stage-03-hail-queued.png (also 03-a/03-c: tree expand receipts) |
| 04 | viewer-open | double-click proof-scratch leaf row | viewer tab opens on the real tmux pane, live output in frame | PASS: proof-scratch tab opened; pane shows the lane's claude TUI having acknowledged all three bus m-ids on screen | stage-04-viewer-open.png |
| 05 | viewer-detach | close the viewer tab (Cmd+W) | tab gone; `tmux has-session` exit 0 | PASS: tab gone, has-session exit 0 in receipts.txt 18:54:00 | stage-05-viewer-detach.png |
| 06 | row-kill | click the row X | has-session exit 1; row leaves the bar | PASS: exit 1 at 18:55:02, count 2 -> 1 | stage-06-row-kill.png |
| 07 | settle-done | dispatch proof-beta, kill its tmux externally | row settles done and leaves the bar, zero clicks | PASS: arrival count 3 (07-a), external kill-session, settled out within 9s (07-b), zero clicks | stage-07-a-beta-arrives.png, stage-07-b-settle-done.png |
| 08 | no-resurrect | double-click the done proof-scratch history row | nothing opens; has-session still exit 1 | PASS: view chip pushed, no tab opened, has-session exit 1, proof sessions 0 | stage-08-no-resurrect.png |
| 09 | waterfall | uncheck Show active | history bars render, proof lanes visible | PASS: 4 session lanes with tick dots; done proof-scratch and proof-oc in history with the live coordinator row | stage-09-waterfall.png |
| 10 | brush | drag the brush | visible set narrows | PASS: west-handle drag narrowed the selection to the right ~half; ticks re-ranged. Session count stayed 4 because all four overlap the window; the narrowing is the selection + tick change | stage-10-brush.png |
| 11 | opencode | dispatch proof-oc with `opencode run`; resolve | resolve exit 0, sessionId in registry, row shows opencode | PASS: dispatch --resolve-wait filled ses_0310f7766ffepHh0gfw1mAryi4 plus model+mode in registry.json (receipts.txt); opencode row in stage-11 PNG. Same flow proven three more times by the flash4 worker lanes | stage-11-opencode.png |
| 12 | scratch-ack | dispatch claude scratch; hail; sweep | to_timestamp filled via cass ack | PASS: after the new `bus resolve` claude leg (8a419c5), sweep acked m-464ddc9e and m-a93b352c; `bus list --agent proof-scratch` = 2 in, 0 unacked (receipts.txt) | stage-12-scratch-ack.png, stage-12b-post-ack.png |
| 99 | restored | cleanup | app state back, no proof residue | PASS: Show active restored, window full-size, sprefa-3 focused, proof tmux count 0, 4 dead routes pruned | stage-99-restored.png |

## Grading criteria (m-17f56e54)

| criterion | verdict | receipt |
|---|---|---|
| agent-count == distinct live panes | PASS | stage-04 PNG: 5 shells on 5 distinct panes (proserail, sprefa-3, sprefa, sprefa-6, proof lane); final frame: 1 == 1 |
| zero seed/store dupes | PASS | proof-scratch renders once as its resolved session 4baa4ba3 (stage-03-c), never beside a seed row |
| zero pane-less rows in the going-on bar | PASS | every bar row in every PNG carries a live tmux; pane-less sessions appear only in history (stage-09) |

## Bonus receipts the run produced

- Transitive dispatch chain renders: fable-main's tab shows my lane, and my
  dispatched lanes nest under it with a twisty (stage-02, stage-03-c).
- The viewer pane shows the scratch claude acknowledging each bus m-id in its
  own TUI: the full envelope -> tmux injection -> harness -> reply loop in one
  frame (stage-04).
- proof-alpha2's sleep expired mid-run and its row left the bar with zero
  clicks: an unplanned second settle-done receipt (stage-06-a vs stage-06).
- Single row click is inert and double-click opens only leaves (c0e13c1,
  Chris's 18:31 request), exercised live throughout stages 03-08.

## Known gaps and honest notes

- App console/trace log is NOT among the artifacts: the debug app was started
  outside this session and its stdout is not reachable from here. The bus
  slice, receipts.txt, and PNG sequence are the run's event record.
- The three proof lanes shared one scratch cwd, so the two routes that
  defaulted to harness "opencode" resolved onto the same opencode session and
  swapped why-chips in history (stage-09: ses_0310f shows proof-alpha2's
  body). Two contributing sharp edges for follow-up: `bus dispatch` defaults
  harness to "opencode" even for plain shell cmds, and resolveRouteSessions
  matches harness+cwd so cwd-sharing lanes can collide. Real lanes get one
  worktree each (the lane law), which sidesteps both.
- Envelopes are append-only and lane ids get reused: a reused id inherits the
  oldest dispatch envelope's from/why chip (why proof-alpha was retired for
  proof-alpha2 mid-run).

## Artifact index

- PNGs: proof-artifacts/stage-*.png (whole-window, retina)
- Bus slice: proof-artifacts/bus-slice.ndjson (17 envelopes, every proof- lane)
- CLI receipts: proof-artifacts/receipts.txt (has-session exits, resolve and
  sweep output, per-stage tmux + bus tails)
- Defects and their fix commits: proof-artifacts/DEFECTS.md
- Lane briefs (flash4 delegation): proof-artifacts/{scribe,kind,click}-brief.md
- Fix commits on instant main this run: 93ddd7f, 2ba14df, 6940b91, c0e13c1, 8a419c5
