# Proof-run defects

Each defect stopped the run, got a fix commit on instant main, and forced a
restart from stage 01 (brief.md law). Defect 4 was found and fixed between
restarts.

| # | found at stage | defect | fix commit | rerun |
|---|---|---|---|---|
| 1 | pre-run (Chris screenshot 17:57) | every strip row joined tmux sprefa-2: claude TUI renames its proc to a bare version string, so the pane join never recognized a claude pane and the lone codex pane won every harness tiebreak; panes were also shareable, so rows outnumbered live panes | 93ddd7f | run restarted |
| 2 | stage 02 (attempt 1, stage-02-dispatch.png first capture) | dispatched lane invisible on the grandparent coordinator's tab: registry seeds carried parentId null, so the dispatch edge (envelope `from`) never became a tree link and related scope could not reach the lane | 2ba14df + 6940b91 | run restarted |
| 3 | stage 03 (attempt 2, screenshot-verified 18:31) | peer hails painted as dispatch edges: fable-main's session rendered as instant-fable's child with the coordinator's own report hail as its why; every oldest-envelope loop ignored envelope kind | c0e13c1 (flash4 lane proof-kind) | run restarted |

| 4 | stage 12 | claude lanes could never be sweep-acked: resolve was opencode-only and adopt sets neither sessionId nor sourcePath, so scopedToAgent rejected every cass hit (live mailbox read acked 0 of 31) | 8a419c5 (bus resolve claude leg: newest transcript jsonl -> sessionId + sourcePath) | fixed mid-run; stage 12 passed after |

Interaction change landed mid-run on Chris's direct request (18:31): strip single
row click is inert; double-click expands a parent and opens a leaf (c0e13c1,
flash4 lane proof-click). Stage 04's "double-click opens viewer" now matches the
shipped behavior exactly.
