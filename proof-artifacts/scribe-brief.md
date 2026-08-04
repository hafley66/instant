# proof-scribe lane brief

You are a mechanical scribe lane for a recorded proof run. Work ONLY inside
/Users/chrishafley/projects/instant-handoff. If reality deviates from this
brief, STOP and write the deviation to proof-artifacts/SCRIBE-REPORT.md; do
not improvise. No commits, no pushes, no file edits outside the three files
you own.

Files you OWN (create/overwrite exactly these, nothing else):
1. proof-artifacts/bus-slice.ndjson
2. proof-artifacts/PROOF.draft.md
3. proof-artifacts/SCRIBE-REPORT.md

## Task 1: bus slice
Source: /Users/chrishafley/.agent/mail/bus.ndjson (read-only; never write it).
Write to proof-artifacts/bus-slice.ndjson every line whose `to` field or
`from` field starts with "proof-" (string match on the raw JSON is fine:
grep -E '"(to|from)":"proof-' works). Preserve line order. Validation:
`wc -l proof-artifacts/bus-slice.ndjson` must print 3 or more.

## Task 2: PROOF.draft.md
Read scripts/proof/STAGES.md. Produce proof-artifacts/PROOF.draft.md with:
- Title line: `# Proof run — instant agent navigation + messaging` and below
  it the line `Run of 2026-08-04, app at instant main 6940b91, real tmux
  default socket, real ~/.agent/mail.`
- A markdown table with columns: NN | slug | action | expected | observed |
  artifact. One row per stage from STAGES.md, copying NN, slug, action,
  expected verbatim. In `observed` put exactly `TBD-BY-COORDINATOR`. In
  `artifact` put `proof-artifacts/stage-NN-<slug>.png` with that stage's NN
  and slug.
- A section `## Grading criteria (m-17f56e54)` with these three bullets
  verbatim: `agent-count == distinct live panes`, `zero seed/store dupes`,
  `zero pane-less rows in the going-on bar`.
- A section `## Defects` containing only the line: `See DEFECTS.md.`
Style: no em dashes anywhere.

## Task 3: SCRIBE-REPORT.md
Write proof-artifacts/SCRIBE-REPORT.md: one line per task = done/failed,
the wc -l output of the slice, and nothing else.
