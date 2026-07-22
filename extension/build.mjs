// Bundle each extension entry into a self-contained plain-JS file under dist/.
// Content scripts and MV3 service workers can't use ESM `import`, so the IIFE
// output inlines all local modules (0_types, 1_match, 2_scan) into each entry.
// Usage: `node extension/build.mjs` (one shot) or `--watch`.
import { build } from "vite";
import { resolve } from "node:path";

const entries = ["background", "content", "inject"];
const watch = process.argv.includes("--watch");

await Promise.all(entries.map(async (entry) => {
  await build({
    configFile: false,
    clearScreen: false,
    define: {
      __INSTANT_ACTIVITY_ORIGIN__: JSON.stringify(process.env.INSTANT_ACTIVITY_ORIGIN ?? "http://127.0.0.1:8787"),
    },
    build: {
      outDir: resolve("extension/dist"),
      emptyOutDir: false,
      target: "chrome111", // content_scripts `world: "MAIN"` landed in Chrome 111
      minify: false,
      cssMinify: false,
      watch: watch ? {} : null,
      rolldownOptions: {
        input: resolve(`extension/src/${entry}.ts`),
        output: {
          format: "iife",
          entryFileNames: `${entry}.js`,
        },
      },
    },
  });
}));

if (watch) {
  console.log("[ext] watching…");
  await new Promise(() => {});
}
