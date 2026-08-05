# Gerrit UI extraction lab

Work only in this worktree. Do not modify or merge into the main checkout.

Determine the smallest Apache-2.0 PolyGerrit frontend seam that can render the
Git-only patch-set ledger already implemented in `labs/patchset-ledger` without
running Gerrit, Java, NoteDb, or a Gerrit server.

Required investigation:

1. Inspect current Gerrit source for `polygerrit-ui/app/embed/gr-diff.ts`,
   `embed/diff/gr-diff`, its public `DiffInfo` contract, build targets, runtime
   dependencies, and license obligations.
2. Measure the dependency boundary for the patch-range selector, file list,
   messages list, and complete change view. Record concrete imports and services.
3. Determine whether `gr-diff` can be built or vendored as a standalone browser
   artifact consumed by Instant's Vite application.
4. Map the existing Git ledger receipt onto Gerrit-compatible revision, file,
   and diff data shapes using real `git` output.

Implementation scope:

- Build the smallest runnable prototype under `labs/patchset-ledger`.
- Do not add a Java runtime or Gerrit server.
- Do not create a bespoke row/table UI. If files are shown through product code,
  use the repository's TreeTable stack.
- Preserve numeric dependency/read ordering for new files.
- Add deterministic Vitest coverage for the Git-to-Gerrit-data translation.
- Add a Playwright screenshot receipt if an actual extracted Gerrit component
  renders. Do not imitate Gerrit's UI with handwritten lookalike HTML and call
  that component reuse.
- Record exact commands, output, dependency size, limitations, and source URLs.
- Do not commit, push, merge, or edit the main checkout.

Return a concise findings report with changed files, tests, and receipt paths.
