# CONTRACT: the subagent tree as a bottom subpanel of the terminal tab

Base: branch lab/stripsub at 57560ff (= a35ad6a + lazy tree + mail bus,
plugin vitest green at 68/68 there). FIRST action: `git merge --ff-only
57560ff` (must be a no-op; STOP AND REPORT on failure). Never spawn
subagents. No push. Commit on lab/stripsub. Deliverable = REPORT.md at
worktree root (if the Write tool refuses it, return the content as text;
never work around the refusal).

## User words (verbatim, this is the whole point)
"i want a tmux panel showing a bottom table subpanel like how the files
work, i do not want to see a lone table, that is the exact opposite of
what im asking for"
and, pressing the toggle hotkey today: "im hitting the subagent view
hotkeys and nothing is showing".
And the ruling correction, which OVERRIDES anything below that
contradicts it: "its ur tui table of known claude code agents, we dont
need to manage claude code agents from outside claude code. see those 5
shells? i want to know how many actual sub agent shells going on in a
view that is summonable UNDERNEATH the claude code native agents list
(which is also just bottom of this tab) so i can pretend to 'extend' it
as a bottom bar for external subagents."

Meaning: claude code's own TUI already renders its agent list at the
bottom of its output inside the tab. The strip must NOT duplicate that:
it EXCLUDES the tab's own claude session and its claude-native
subagents. It shows ONLY the externals claude code cannot show —
opencode/codex/kimi sessions and tmux lanes related to this tab (via
dispatch edges, registry, cwd/tmux join) — as a slim bottom bar that
visually reads as one more section under the native agent list. The bar
label carries the live count ("N external shells"). The standalone
HarnessTracePanel page stays untouched (no deletions without user
word); this strip is the real home.

## Ownership note (changed since earlier contracts)
src/main.ts and src/plugins/harnessTrace/InTabStrip.tsx are YOURS in
this worktree. The lane that owned them died without touching them
(verified: its worktree diff has no InTabStrip.tsx and no main.ts).
Everything in the worktree is yours.

## Known bugs to fix (diagnosed by the coordinator, verify then fix)
1. main.ts toggleTermStrip (lines ~129-135): absent entry defaults
   `{ open: true }` and the toggle writes `!cur.open`, so the FIRST
   hotkey press on a fresh terminal writes open:false — summoning feels
   dead. Fix: an absent entry means the strip is not visible (because of
   bug 2), so the first press must summon: write `{ open: true }` when
   absent, flip only when an entry exists.
2. InTabStrip.tsx:39: `visible = open && (filtered.length > 0 ||
   !!current)` renders NOTHING on explicit summon when there are zero
   related rows. Fix: an explicit store entry with open:true always
   renders the shell; the empty state shows the tab's sid and a short
   "no related sessions" hint (the sid is diagnostic: tmux-opened tabs
   have sid == tmux session name, plain tabs may not, and the hint tells
   the user which case they are in).

## The upgrade (the actual ask)
Replace the strip's flat filtered `AgentStripTable` body with the SAME
lazy tree the trace page got: `indexAgentTree` + `materializeAgentTree`
+ TreeTable with twisties (see HarnessTracePanel.tsx on this branch for
the working wiring), with the link (subagent/dispatch) and status
columns. Behavior:
- Default scope: EXTERNAL sessions related to this tab — trees joined to
  this terminal's tmux session (the existing filterForestByTmux) MINUS
  every claude-harness row belonging to this tab's own session and its
  claude-native subagents (the TUI shows those already). PLUS a control
  to widen to all external roots (the user wants to find opencode lanes
  and jump to them even when the cwd join fails).
- Row click keeps today's behavior: join the tmux session if the row has
  one, push the agent-session view.
- Render the mail-preview view when it is the router top
  (busmail's missing leg 3):
  `current?.kind === "mail-preview"` renders `<MailPreview .../>`
  instead of the table. Add the mail row action that pushes it (the
  re-anchoring the busmail REPORT section 5 describes, now in the strip
  body's row actions rather than the standalone page).
- Match the files-subpanel interaction pattern where it applies
  (src/main.ts toggleTermSidebar + the files plugin,
  src/plugins/files/1_FileTree.tsx): per-terminal persisted open state,
  height behavior, and the onLayout refit contract already in
  InTabStrip.
- Cap and scroll stay as today (240px, auto-height).

## Style laws (repo)
- Interfaces in 0_types.ts (append at end). Comment budget: constraints
  only. Colocated consistency. Frozen clock in any e2e rendering
  relTime. Playwright on a private port with reuseExistingServer:false
  (4173 is poisoned by sibling worktrees; pick an unused port).

## Gates (outputs in REPORT.md)
- npx tsc --noEmit (one pre-existing plugin.test.ts error known; no new)
- npx vitest run src/plugins/harnessTrace (green, plus new cases for the
  toggle-summon fix and the empty shell)
- npx vitest run (base is 4 failed panelZoom pre-existing | rest pass;
  no new failures)
- Playwright: extend/replace e2e/dock-strip-in-tab.spec.ts — receipts:
  (a) fresh terminal, hotkey once -> shell appears with sid + hint
  (the bug-1+2 fix, fail-first: show it red at base),
  (b) related sessions -> lazy tree with twisties expands under the
  term, (c) mail action pushes and MailPreview renders in the strip,
  (d) back pops to the tree. PNG of (b) and (c), paths in REPORT.md.

## REPORT.md sections
bug receipts (red at base) / tree-in-strip wiring / widen control /
mail render / gates / PNG paths.
