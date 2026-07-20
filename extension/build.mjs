// Bundle each extension entry into a self-contained plain-JS file under dist/.
// Content scripts and MV3 service workers can't use ESM `import`, so bundle:true
// inlines all local modules (0_types, 1_match, 2_scan) into each output.
// Usage: `node extension/build.mjs` (one shot) or `--watch`.
import { build, context } from "esbuild";

const opts = {
  entryPoints: [
    "extension/src/background.ts",
    "extension/src/content.ts",
    "extension/src/inject.ts",
  ],
  outdir: "extension/dist",
  bundle: true,
  format: "iife",
  target: "chrome111", // content_scripts `world: "MAIN"` landed in Chrome 111
  logLevel: "info",
  define: {
    __INSTANT_ACTIVITY_ORIGIN__: JSON.stringify(process.env.INSTANT_ACTIVITY_ORIGIN ?? "http://127.0.0.1:8787"),
  },
};

if (process.argv.includes("--watch")) {
  const ctx = await context(opts);
  await ctx.watch();
  console.log("[ext] watching…");
} else {
  await build(opts);
}
