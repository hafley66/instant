import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["labs/patchset-ledger/2_lab.test.ts", "labs/patchset-ledger/8_git_to_gerrit.test.ts"],
  },
});
