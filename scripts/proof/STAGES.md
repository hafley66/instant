# Proof-run stage checklist

Vehicle: the running debug app (default tmux socket, real ~/.agent/mail).
Every lane id carries `proof-`. Each stage: run the action, `stage.sh NN slug`,
verify the PNG by eye, log observed in PROOF.md. A failed feature stops the
run: fix lane, then the WHOLE run restarts from stage 01 (brief.md law).

| NN | slug | action | expected |
|---|---|---|---|
| 01 | baseline | none | app front, strip visible, no proof- rows |
| 02 | dispatch | `boop beep lane create --lane proof-alpha --cwd <tmp> --goal 'sleep 600' --harness opencode` | row proof-alpha appears with ZERO clicks (mail fs-watch), status live |
| 03 | hail-queued | `boop beep hail proof-alpha --body 'proof ping'` then open its mail queue | envelope queued/unacked in MailPreview |
| 04 | viewer-open | double-click proof-alpha row | viewer tab opens on the real tmux pane, live output in frame |
| 05 | viewer-detach | close the viewer tab | tab gone; `tmux has-session -t proof-alpha` exit 0 (receipts.log) |
| 06 | row-kill | click the row X | `has-session` exit 1; row leaves the bar |
| 07 | settle-done | dispatch proof-beta, then `tmux kill-session` externally | row settles done and leaves the going-on bar, zero clicks |
| 08 | no-resurrect | double-click the done proof-beta row (trace page/dock strip) | nothing opens; `has-session` still exit 1 |
| 09 | waterfall | uncheck Show active | history bars render, proof lanes visible |
| 10 | brush | drag the brush | visible set narrows; screenshot shows the narrowed range |
| 11 | opencode | `boop beep lane create --lane proof-oc --cwd <tmp> --goal 'opencode run …'`; `boop beep lane route proof-oc` | route exit 0, sessionId in registry; row shows opencode |
| 12 | scratch-ack | create proof-scratch running claude; hail it; `boop beep message ack --lane proof-scratch` | envelope to_timestamp filled (cass ack); receipts.log holds Boop list |

Artifacts land in proof-artifacts/: stage PNGs, receipts.log, mail.ndjson slice
(grep the run's m-ids), and the app trace log. PROOF.md holds the final table;
failures and their fix commits go to DEFECTS.md.
