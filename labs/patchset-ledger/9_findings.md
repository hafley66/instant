# Findings — smallest Apache-2.0 PolyGerrit seam for the Git patch-set ledger

Worktree: `.worktrees/patchset-ledger-lab`, branch `lab/patchset-ledger`. No commit, push,
merge, or main-checkout edit performed. Gates: the lab lives under `labs/` and is outside the
repo's typed `src` surface (same as the existing `1_lab.ts`), which does not import `@types/node`.

## TOC

1. Verdict
2. Seam measured — `embed/gr-diff.ts` + `DiffInfo` contract
3. Dependency boundary — patch-range selector, file list, messages, full change view
4. Standalone build/vendor feasibility for Instant's Vite app
5. Git ledger → Gerrit shapes (translation prototype)
6. Changed files, tests, receipts
7. Commands and sizes
8. Limitations

## 1. Verdict

The smallest Apache-2.0 PolyGerrit seam a Git-only app can consume **without** the Gerrit Bazel
build and **without** a Java runtime is the **`DiffInfo` contract types** from
`polygerrit-ui/app/api/diff.ts` plus a **data translator** that turns real `git` output into those
shapes. That translator is what this lab implemented and tested.

The real `gr-diff` **component** (a LitElement) is not published as a standalone browser artifact.
It is built only inside the PolyGerrit Bazel repository and transitively depends on ~50 sibling
modules (DiffModel DI, app-context mocks, shared gr-button/gr-icon elements, syntax layers,
subscription controllers). Rendering it standalone is feasible on paper but conflicts with the
"no Java runtime / smallest prototype" constraints.

## 2. Seam measured — `embed/gr-diff.ts` + `DiffInfo`

Source (mirror of `https://gerrit.googlesource.com/gerrit`, `master`, fetched 2026-08-05):

| Item | Path | Notes |
|---|---|---|
| Component entry | `polygerrit-ui/app/embed/gr-diff.ts` | Side-effect imports `../api/embed`, `./diff/gr-diff/gr-diff`, `./gr-textarea`, `./diff/gr-diff-cursor/gr-diff-cursor`; exposes `window.grdiff` |
| Embed entry point | `embed/gr-diff-entry-point.ts` | "DO NOT EXPORT ANYTHING" — a pure side-effect bundle entry |
| App-context with mocks | `embed/gr-diff-app-context-init.ts` | Mocks `FlagsService`, `AuthService`, `grReportingMock`; `restApiService`/`eventEmitter` throw — the component assumes a host supplies them |
| Component root | `embed/diff/gr-diff/gr-diff.ts` (1086 lines) + `gr-diff-element.ts` (431) | `class GrDiffElement extends LitElement` |
| Public contract | `api/diff.ts` | `DiffInfo`, `DiffContent`, `DiffFileMetaInfo`, `ChangeType`, `DiffViewMode`, `RenderPreferences` |
| Diff local types | `types/diff.ts` | `DiffInfo extends DiffInfoApi` (adds `DiffPreferencesInfo`-adjacent fields) |
| Feed seam | `embed/diff/gr-diff-model/gr-diff-model.ts` | `DiffModel extends Model<DiffState>`; `diffModelToken = define<DiffModel>('diff-model')`; viewers subscribe to `diff$`, `baseImage$` (`gr-diff-element.ts:84-113`) |

License: every retrieved file carries `SPDX-License-Identifier: Apache-2.0` with
`Copyright ... Google LLC` (root `LICENSE` is Apache-2.0). The `DiffInfo` shapes are restatable
under the same license; this lab keeps the local type copy with a mapping comment so a consumer
can rebind to upstream.

## 3. Dependency boundary

Concrete imports measured into the component root (`gr-diff-element.ts` / `gr-diff.ts`) reach:
internal `DiffModel` + `models/dependency` DI, `elements/lit/subscription-controller`,
`elements/shared/gr-button`, `elements/shared/gr-icon`, `gr-diff-*` layers (highlight, selection,
syntax, ranged-comment, coverage, focus, image-viewer, builder), `utils/*`, and `types/*`, plus
external `lit` (`lit/decorators.js`, `lit/directives/*`).

View-by-view services boundary (the four views named in the lab brief — none is a "view" in
PolyGerrit; each is a component + model + REST path):

| View | Component/model seam | Services it would need standalone |
|---|---|---|
| Patch-range selector | `elements/change/gr-change-view` (range picker) + `change-view-model` | `restApiService` (getDiffFiles, listChanges) |
| File list | `gr-file-list` -> `gr-file-list-header` | `restApiService` (change revisions, file list), `appContext` |
| Messages list | `gr-change-messages` | `changeModel`, `restApiService` (change messages) |
| Full change view | `gr-change-view` | change, diff, comments models; avatar/account services; router |

Size of the app the embedding would drag in:

| Scope | Files (.ts) | MB |
|---|---|---|
| `polygerrit-ui/app` total | 815 | 7.80 |
| `embed/` | 63 | 0.747 |
| `embed/diff/` | 57 | — |
| `elements/` | 518 | 5.402 |
| `models/` | 50 | 0.436 |
| `services/` | 47 | 0.397 |

External npm deps (`polygerrit-ui/app/package.json`): `lit`, `rxjs`, `immer`, `marked`,
`safevalues`, `web-vitals`, `@material/web`, `@polymer/font-roboto-local`, `@webcomponents/shadycss`,
`highlight.js` + a closure/epp/ttcn3/vue highlight stack, `resemblejs`, `highlightjs-closure-templates`.

## 4. Standalone build/vendor feasibility for Vite

- **Not on npm.** The only published artifact is `@gerritcodereview/typescript-api` 3.14.0
  (`api/package.json`, `dependencies: {}`), a **types-only** plugin API. It does not ship `gr-diff`.
- **Build is Bazel-only.** `polygerrit-ui/polygerrit.MODULE.bazel` + `app/BUILD`
  (`ts_project(name="compile_pg")` over all `src_dirs` incl. `embed`, plus `polygerrit_bundle`).
  No standalone Vite/rollup entry for the embed target is published. Bazel itself boots on a JVM
  toolchain, so even building the frontend drags in Java — collides with the brief's "no Java".
- **Vendoring the whole `app/` tree** (815 files / 7.8 MB) + deps and wiring a custom Vite build of
  `embed/gr-diff-entry-point.ts` is the only no-Java path, and it is the opposite of "smallest".
- **Verdict:** the standalone `gr-diff` component is not cheaply consumable; the **contract seam**
  (`api/diff.ts` types) is. This lab implements the contract seam + translator.

## 5. Git ledger → Gerrit shapes (implemented)

`7_git_to_gerrit.ts` maps real `git` output to Gerrit `DiffInfo`:

| Git output | Gerrit shape produced |
|---|---|
| `git diff --name-status <from> <to>` | per-file `change_type` (ADDED/MODIFIED/DELETED/RENAMED/COPIED/REWRITE) |
| `git show <commit>:<path>` (blob text) | `meta_a` / `meta_b` (`name`, `content_type`, `lines`) |
| LCS edit script over the two blobs | `content[]` as `ab` / `a` / `b` segments |
| NUL byte scan | `binary: true`, `application/octet-stream` content type |

## 6. Changed files, tests, receipts

| File | Role |
|---|---|
| `1_lab.ts` | Git-only patch-set ledger (pre-existing, unchanged) |
| `3_receipt.spec.ts` | Extended with a second test rendering the translated DiffInfo |
| `4_vitest.config.ts` | Now also includes `8_git_to_gerrit.test.ts` |
| `7_git_to_gerrit.ts` | **new** — git→Gerrit translator + embedded `DiffInfo` contract |
| `8_git_to_gerrit.test.ts` | **new** — 14 deterministic Vitest cases (edit script, grouping, ADDED/MODIFIED/DELETED/binary, name-status raw + `-z` + rename, real-git seam) |
| `9_findings.md` | this report |
| `README.md` | updated command + receipt list |

Tests/receipts:
- Vitest: `pnpm vitest run --config labs/patchset-ledger/4_vitest.config.ts` → **2 files, 15 passed**.
- Playwright: `pnpm playwright test --config labs/patchset-ledger/5_playwright.config.ts` → **2 passed**.
- Receipts: `labs/patchset-ledger/3_receipt.spec.ts-snapshots/patchset-ledger-darwin.png` (ledger),
  `patchset-gerrit-translation-darwin.png` (translated DiffInfo data), plus
  `../../playwright-report/patchset-ledger/index.html`.

## 7. Commands and sizes

- Investigation: `curl` to GitHub raw/API for the Gerrit source (mirror); no local Gerrit clone.
- Build command attempted for the lab surface: none (lab files run through Vite/esbuild via Vitest,
  consistent with `1_lab.ts`).
- Dependency footprint added by the lab: **0 new repo deps**; `7_git_to_gerrit.ts` uses only
  `node:` built-ins already present.

## 8. Limitations

- The screenshot receipt renders **translated data, not the real Gerrit UI**. The lab's screenshot
  clause for an "actual extracted Gerrit component" is intentionally not exercised because the real
  `gr-diff` component is Bazel-only (needs a JVM toolchain), which the brief forbids. No lookalike
  HTML was passed off as component reuse.
- Intraline `edit_a`/`edit_b` are not emitted; `intraline_status` is fixed to `OK` (segments are
  whole-line replace chunks).
- `myersDiff` is O(N*M); fine for ledger-scale files, not for megabyte diffs.
- No comment/thread or blame data is mapped; the seam covers revision/file/diff shapes only.
