import { defineConfig } from "vitest/config";

// The live-spawn gate's own runner. Kept out of vitest.config.ts (which
// includes src/** only) so the gate never joins a default battery: it asserts
// over a recorded wall-clock run that costs minutes and real tokens.
//   node scripts/livespawn.ts --scratch <dir>
//   LIVESPAWN_RUN=<dir>/run.json npx vitest run --config vitest.livespawn.config.ts
export default defineConfig({
  test: {
    environment: "node",
    include: ["labs/livespawn/*.test.ts"],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
