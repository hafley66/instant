# Patch-set ledger lab

`0_pre-push` turns each pushed branch state into an immutable local ref:

```text
refs/instant/changes/<branch>/1
refs/instant/changes/<branch>/2
```

Install it in one repository:

```sh
cp labs/patchset-ledger/0_pre-push .git/hooks/pre-push
chmod +x .git/hooks/pre-push
```

The hook has no daemon, database, Gerrit protocol, or GitHub API dependency. A
branch is one change; every pushed branch tip is a patch set containing one or
more ordinary commits. The lab test rebases a two-commit branch onto `main`,
force-pushes with lease, expires every reflog, prunes Git objects, and compares
the two retained branch patch sets.

```sh
pnpm vitest run --config labs/patchset-ledger/4_vitest.config.ts
pnpm playwright test --config labs/patchset-ledger/5_playwright.config.ts
```

Receipts are written to:

- `3_receipt.spec.ts-snapshots/patchset-ledger-darwin.png`
- `3_receipt.spec.ts-snapshots/patchset-gerrit-translation-darwin.png`
- `../../playwright-report/patchset-ledger/index.html`

## Git → Gerrit data translation

`7_git_to_gerrit.ts` maps real `git` output (`git diff --name-status`, `git show <sha>:<path>`)
onto PolyGerrit's `DiffInfo` contract (`api/diff.ts`, Apache-2.0). `8_git_to_gerrit.test.ts` covers
the translation deterministically; the attached receipt renders the translated data. See
`9_findings.md` for the dependency-boundary measurement and feasibility verdict.
