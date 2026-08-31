import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Options } from "@wdio/types";

const root = path.dirname(fileURLToPath(import.meta.url));
const binary = path.join(root, "src-tauri", "target", "debug", "instant");

// The service-spawned process inherits these values. They suppress Instant's
// process-wide tray, shortcut, and event-tap surfaces and isolate its tmux socket
// from the owner's active app before the compiled binary starts.
process.env.INSTANT_NO_GLOBALS = "1";
process.env.INSTANT_TMUX_SOCKET = "instant-native-e2e";

export const config: Options.Testrunner = {
  runner: "local",
  specs: ["./e2e-native/0_native.spec.ts"],
  maxInstances: 1,
  capabilities: [{
    browserName: "tauri",
    "tauri:options": { application: binary },
  }],
  services: [["@wdio/tauri-service", {
    appBinaryPath: binary,
    driverProvider: "embedded",
    embeddedPort: 4455,
    windowLabel: "main",
    captureBackendLogs: true,
    startTimeout: 60_000,
  }]],
  framework: "mocha",
  reporters: ["spec"],
  logLevel: "info",
  outputDir: path.join(root, ".native-e2e-results"),
  waitforTimeout: 15_000,
  connectionRetryTimeout: 90_000,
  connectionRetryCount: 1,
  mochaOpts: {
    ui: "bdd",
    timeout: 60_000,
  },
};
