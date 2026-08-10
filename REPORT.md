# File-tree grid migration

## Commit

`PENDING` at report authoring time. The task commit is created after this report is staged.

## Checks

- `just check` passed. The linked-worktree database check used the repository's documented cold-build skip.
- `just cargo-check` passed.
- `pnpm exec vitest run src/plugins/files/1_FileTree.test.ts` passed: 4 tests.
- `pnpm exec vite build` passed.

## Receipts

- [collapsed](receipts/file-tree-collapsed.png)
- [expanded](receipts/file-tree-expanded.png)

## Parity gaps

- `GridTree` supplies fixed rendering and does not expose the former column, row-class, title, search, or keyboard-navigation hooks. The migration keeps the grid tree renderer and native expansion event path; active-path styling and in-grid filtering need package-level extension points.
- Markdown heading rows remain in the cache model, but the published `GridTree` row contract only renders rows with the package's `name` and `kind` fields. Heading-specific rendering and activation require a package callback or a follow-up adapter.
- The published grid package imports named exports from CommonJS `lodash`; the Vite and Vitest configs route that import through `src/0_lodashOrderBy.ts` so the package resolves in this ESM build.
