import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const worktreeKey = createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);
const pidPath = join(tmpdir(), `instant-dev-auto-${worktreeKey}.pid`);

try {
  const previousPid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
  if (Number.isInteger(previousPid) && previousPid !== process.pid) {
    try {
      process.kill(previousPid, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

await writeFile(pidPath, `${process.pid}\n`);

const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close(() => reject(new Error("could not allocate a loopback port")));
      return;
    }
    server.close((error) => error ? reject(error) : resolve(address.port));
  });
});

const config = JSON.stringify({
  productName: "instant-dev-auto",
  identifier: "com.instant.summon.dev-auto",
  build: {
    beforeDevCommand: `corepack pnpm@10.12.4 run dev --host 127.0.0.1 --port ${port}`,
    devUrl: `http://127.0.0.1:${port}`,
  },
});

process.stdout.write(`Instant dev port: ${port}\n`);
const child = spawn(
  "corepack",
  ["pnpm@10.12.4", "tauri", "dev", "--config", config],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      INSTANT_NO_GLOBALS: "1",
      INSTANT_TMUX_SOCKET: `instant-dev-${port}`,
    },
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.once("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
