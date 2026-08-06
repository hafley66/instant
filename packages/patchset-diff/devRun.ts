import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "vite";

export interface DevRunOptions {
  /** Absolute repo paths a request may name. The first is the default. */
  cwd: string | readonly string[];
  /** Only these binaries may be spawned. */
  allow?: readonly string[];
  route?: string;
  /** Route serving an ImageMagick pixel difference. */
  compareRoute?: string;
}

// Dev-only seam so the browser can reach a PatchsetSource. The allowlist and the
// fixed cwd are the whole sandbox; this never ships in a build.
export function devRun({ cwd, allow = ["jj", "git"], route = "/_run", compareRoute = "/_compare" }: DevRunOptions): Plugin {
  const roots = typeof cwd === "string" ? [cwd] : cwd;
  return {
    name: "patchset-diff-dev-run",
    apply: "serve",
    configureServer(server) {
      // `compare` writes a red overlay of every changed pixel and exits 1 when
      // the images differ, which is the normal path here rather than a failure.
      server.middlewares.use(compareRoute, (request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", async () => {
          const send = (status: number, body: unknown) => {
            response.statusCode = status;
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify(body));
          };
          let payload: { a?: string; b?: string; cwd?: string } = {};
          try {
            payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            return send(400, { error: "bad json" });
          }
          const runIn = payload.cwd ?? roots[0];
          if (!roots.includes(runIn)) return send(403, { error: `blocked cwd: ${runIn}` });
          if (!payload.a || !payload.b) return send(400, { error: "need a and b" });
          const dir = await mkdtemp(join(tmpdir(), "patchset-cmp-"));
          try {
            await writeFile(join(dir, "a.png"), Buffer.from(payload.a, "base64"));
            await writeFile(join(dir, "b.png"), Buffer.from(payload.b, "base64"));
            const out = await new Promise<string>((resolve, reject) => {
              execFile(
                "magick",
                ["compare", "-metric", "AE", "-highlight-color", "red", "-lowlight-color", "rgba(0,0,0,0.35)",
                 join(dir, "a.png"), join(dir, "b.png"), join(dir, "d.png")],
                (failure, _stdout, stderr) => {
                  // exit 1 = images differ, which is what we are here for.
                  const code = (failure as { code?: number } | null)?.code;
                  if (failure && code !== 1) return reject(new Error(stderr || String(failure)));
                  resolve(String(stderr).trim());
                },
              );
            });
            const png = await new Promise<string>((resolve, reject) => {
              execFile("magick", [join(dir, "d.png"), "png:-"], { encoding: "base64", maxBuffer: 64 << 20 },
                (failure, stdout) => (failure ? reject(failure) : resolve(stdout as unknown as string)));
            });
            send(200, { png, changedPixels: Number(out.split(" ")[0]) || 0 });
          } catch (failure) {
            send(500, { error: String(failure) });
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        });
      });

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
