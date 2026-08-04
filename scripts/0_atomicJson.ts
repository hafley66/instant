// Optimistic content-hashed compare-and-swap write for registry.json. The
// mutation runs against the exact bytes that were hashed, so a concurrent
// writer is detected by a hash mismatch, never by wall-clock mtime.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export class CorruptJsonError extends Error {}

export interface ICasOptions {
  retries?: number;
  afterRead?: () => void;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sleepJittered() {
  const ms = 1 + Math.floor(Math.random() * 20);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function casUpdateJson(
  path: string,
  mutate: (current: Record<string, unknown>) => Record<string, unknown>,
  options: ICasOptions = {},
): Record<string, unknown> {
  const maxAttempts = options.retries ?? 5;
  for (let attempt = 0; ; attempt += 1) {
    let raw: Buffer | null = null;
    try {
      raw = readFileSync(path);
    } catch {
      raw = null;
    }
    let current: Record<string, unknown>;
    let digest: string | null;
    if (raw === null) {
      current = {};
      digest = null;
    } else {
      try {
        current = JSON.parse(raw.toString("utf8"));
      } catch {
        throw new CorruptJsonError(`registry.json is invalid JSON at ${path}`);
      }
      digest = sha256(raw);
    }
    options.afterRead?.();
    const next = mutate(structuredClone(current));
    let fresh: Buffer | null = null;
    try {
      fresh = readFileSync(path);
    } catch {
      fresh = null;
    }
    if ((fresh === null ? null : sha256(fresh)) === digest) {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp-${process.pid}-${globalThis.crypto.randomUUID().slice(0, 8)}`;
      let renamed = false;
      try {
        writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
        renameSync(tmp, path);
        renamed = true;
      } finally {
        if (!renamed && existsSync(tmp)) unlinkSync(tmp);
      }
      return next;
    }
    if (attempt >= maxAttempts) {
      throw new Error(`casUpdateJson gave up after ${maxAttempts} attempts`);
    }
    sleepJittered();
  }
}
