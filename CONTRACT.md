# CONTRACT: harness trace page -> lazy tree (who called who)

Base sha: a35ad6a. FIRST action: `git merge --ff-only a35ad6a` (must be a
no-op; STOP AND REPORT on failure). Never spawn subagents. No push. Commit
on this branch (lab/tracetree) only. Deliverable = REPORT.md at this
worktree root.

## User words (verbatim, scope law)
"this page tells me literally nothing because i have no idea who called
who, this should be tree data like other tables and also lazy load and
also i will never use this view"
and, same session: "i still do not have a sub agent view that spans both
[tmux shells and claude subagents]".
Read that as: the flat table is worthless in current form; convert, don't
gold-plate. Minimal diff, reuse existing components.

## Current state
- Page: src/plugins/harnessTrace/HarnessTracePanel.tsx — flat table,
  1086 sessions, columns harness/session/from/why/status, eager.
- Tree machinery ALREADY EXISTS in the same plugin: 0_tree.ts +
  0_tree.test.ts (built for the dock strip tree, commit b45f180), fed by
  the harness.rs subagent walk (parentId/parentKind) on the rust side.
- DockStripPanel.tsx / InTabStrip.tsx render that tree per-tab; the trace
  page ignores it.
- Harness readers exist for claude jsonl, opencode.db, codex, kimi; the
  rows in the flat table already come from them.

## Required behavior
1. Root rows = sessions with no parent; children = sessions whose
   parentId points at them (claude subagents) — same parent model the
   strip uses. A tmux/opencode lane dispatched by a claude session
   appears under it when the parent link exists in the data; if no link
   exists in the data, DO NOT invent one (report which edge is missing
   instead).
2. Expand/collapse per row; children resolved lazily on expand — no
   1086-row eager render. Keep the filter box working (filter may operate
   on loaded rows only; say so in the UI if so).
3. Keep harness/from/why/status columns on every row.
4. Do not touch InTabStrip.tsx or src/main.ts — another lane
   (lane-turns) owns them right now. If the change seems to need them,
   STOP AND REPORT.

## Style laws (repo)
- Interfaces in the plugin's 0_types.ts; comment budget = constraints
  only; follow the file's existing state-management style.
- Frozen clock (page.clock.setFixedTime) in any e2e that renders relTime.

## Gates (outputs pasted in REPORT.md)
- npx tsc --noEmit
- npx vitest run src/plugins/harnessTrace
- full: npx vitest run
- Existing playwright e2e for the panel if present; screenshot (PNG path
  in REPORT.md) showing the tree expanded two levels.

## REPORT.md sections
data model (which edges exist, which are missing) / component reuse map /
lazy-load mechanism / gate outputs / PNG path.
