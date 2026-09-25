---
created: 2026-09-24
updated: 2026-09-24
type: feature
reporter: owner
status: untriaged
priority: normal
provenance: other
provenance_detail: claude session 8869876b
source_ref: claude:8869876b/turn-hover-square
---

# Hovering a known turn in a tmux pane highlights its square in the squares strip

## Description

When the pointer is over rows that boop-mux/turn attribution maps to a known turn, the matching square in the agent squares strip gets a hover class (extra highlight). Leaving the rows removes it. Source of truth for row->turn is the existing turn projection (TerminalTurnVisibilityV2 visible regions); the strip only reads a hovered-turn signal. Screenshot: squares strip beside a claude pane, 'claude · bound session' tooltip.
