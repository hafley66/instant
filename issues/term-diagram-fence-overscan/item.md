---
created: 2026-09-25
updated: 2026-09-25
type: bug
reporter: owner
status: fixed
priority: normal
closed: 2026-09-25
---

# Terminal diagram overlay scans stripped/inferred fences past their end and paints parse errors over the pane

## Description

## Comments

### 2026-09-25T05:08:22Z · @claude

Branch fix/overlay-md-remount (instant-wt/overlay-md/instant): 65288a1f ends stripped/inferred fences at box-drawing (U+2500-257F), bullet, prompt rows and inferred mermaid at a dedent; a failed render draws nothing (reason on .term-diagrams[data-diagram-error]). de82ab1b: a blank row ends a stripped mermaid fence. src/0_terminalDiagrams.test.ts: 5 fail before 65288a1f (screenshot shape 'G --> SQ┌──'), 1 fails before de82ab1b ('1-6' vs '1-3'); 38/38 pass at HEAD.
