import { execFile } from "node:child_process";
import type { Plugin } from "vite";

export interface DevRunOptions {
  /** Absolute repo paths a request may name. The first is the default. */
  cwd: string | readonly string[];
  /** Only these binaries may be spawned. */
  allow?: readonly string[];
  route?: string;
}

// Dev-only seam so the browser can reach a PatchsetSource. The allowlist and the
// fixed cwd are the whole sandbox; this never ships in a build.
export function devRun({ cwd, allow = ["jj", "git"], route = "/_run" }: DevRunOptions): Plugin {
  const roots = typeof cwd === "string" ? [cwd] : cwd;
  return {
    name: "patchset-diff-dev-run",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(route, (request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const send = (status: number, body: unknown) => {
            response.statusCode = status;
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify(body));
          };
          let bin = "";
          let args: string[] = [];
          let root: string | undefined;
          let encoding: BufferEncoding | undefined;
          try {
            ({ bin, args, cwd: root, encoding } = JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            return send(400, { error: "bad json" });
          }
          if (!allow.includes(bin)) return send(403, { error: `blocked: ${bin}` });
          const runIn = root ?? roots[0];
          if (!roots.includes(runIn)) return send(403, { error: `blocked cwd: ${runIn}` });
          const encode = encoding === "base64" ? "base64" : "utf8";
          execFile(bin, args, { cwd: runIn, maxBuffer: 64 << 20, encoding: encode }, (failure, stdout, stderr) => {
            if (failure) return send(500, { error: stderr || String(failure) });
            send(200, { stdout });
          });
        });
      });
    },
  };
}
