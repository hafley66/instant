---
created: 2026-09-25
updated: 2026-09-25
type: bug
reporter: owner
status: fixed
priority: normal
closed: 2026-09-25
---

# Terminal inline diagrams still glitch until a scroll after scan-settle fix

## Description

## Comments

### 2026-09-25T05:08:22Z · @claude

Branch fix/overlay-md-remount: 90a6cd97 keeps a painted stripped fence in the plan while scans run (test failed before: diagram blinked out each scan). cb1786bd: settle records stripped fences on the buffer (settledKeys, src/0_terminalDiagrams.ts); a settle repaint queued behind an in-flight render ran after the next scan began and withheld the fence under PTY activity. Test 'paints a stripped fence a settled scan saw even when the next scan starts before the repaint': before [[0],[0],[0]], after [[0,5]x3]. 38/38 pass.
