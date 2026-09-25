---
created: 2026-09-24
updated: 2026-09-24
type: feature
reporter: owner
status: untriaged
priority: low
provenance: other
provenance_detail: claude session 8869876b
source_ref: claude:8869876b/fence-reflow
---

# Best-effort reflow of code fences to pane width via formatters found on PATH

## Description

Nice-to-have. When a formatter is installed on PATH, shell out to reformat a code fence to the pane's column width so code neither word-wraps nor scrolls horizontally. Absent formatter = render unchanged. No bundled formatters or wasm (binary size).

Candidates by language (width flag): prettier printWidth (js/ts/json/css/md/yaml), rustfmt max_width, golines -m (gofmt has no width), ktfmt --max-width (JVM cold start ~0.5s), ruff format line-length (python), shfmt (normalizes only, no width).
Cache formatted output by (language, width, source hash).
