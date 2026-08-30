# Task: add one JSON-Rx lab gate

Worktree: `/Users/chrishafley/projects/instant/.worktrees/flash-json-rx-gate`

Perform exactly this mechanical task:

1. Add one recipe named `json-rx-lab` to the root `justfile`.
2. The recipe must run these existing commands, in this order, with the repository's pinned package-manager form:
   - `corepack pnpm@10.12.4 exec vitest run --config labs/json-rx-mvp/5_vitest.config.ts`
   - `corepack pnpm@10.12.4 exec tsc --project labs/json-rx-mvp/6_tsconfig.json`
3. Update only the `## Run` section of `labs/json-rx-mvp/README.md` so `just json-rx-lab` is the primary command. Preserve the two raw commands as the explicit expansion of the recipe.
4. Run `just json-rx-lab` and record its exact result.
5. Write `REPORT.md` at the worktree root containing changed files, the recipe body, and the validation result.

Constraints:

- Use `apply_patch` for file edits.
- Do not install dependencies or modify any lockfile.
- Do not change application, extension, Rust, lab runtime, fixture, test, schema, or TypeScript configuration files.
- Do not commit, push, merge, or edit the main checkout.
- Preserve unrelated repository state.
- If the existing justfile syntax or lab paths differ from this brief, STOP and report the deviation. Do not improvise.
- Do not broaden the task into production JSON-Rx integration or design work.
