import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const specPath = resolve(root, "ipc/commands.json");
const outputPath = resolve(root, "src/generated/native.ts");
const groups = JSON.parse(await readFile(specPath, "utf8"));
const names = Object.values(groups).flat();
const camel = (value) => value.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());

const namespaces = Object.entries(groups).map(([group, commands]) => `  export namespace ${group} {
${commands.map((command) => `    export const ${camel(command)} = ${JSON.stringify(command)};`).join("\n")}
  }`).join("\n\n");

const generated = `// Generated from ipc/commands.json by scripts/generate-native.mjs.
// Do not edit by hand. Run: corepack pnpm@10.12.4 api:generate
import { firstValueFrom } from "rxjs";
import type { Serializable } from "@hafley66/signals";
import { createRequestEndpoint } from "../reactive/0_requestTransport";
import {
  nativeCommandUrl,
  nativeRequestTransport,
  type NativeCommandInput,
} from "../reactive/nativeTransport";

export type CommandName =
${names.map((name) => `  | ${JSON.stringify(name)}`).join("\n")};

export function commandEndpoint<T = unknown>(
  command: CommandName,
) {
  return createRequestEndpoint<NativeCommandInput, T>({
    request: (args) => ({
      url: nativeCommandUrl(command),
      method: "POST",
      body: args as unknown as Serializable,
    }),
    decode: (response) => {
      if (response.status < 200 || response.status >= 300) {
        throw new Error("native command " + command + " returned HTTP " + response.status);
      }
      return response.body as T;
    },
  }, nativeRequestTransport);
}

// Compatibility boundary for existing async call sites. The request itself is
// an Endpoint observable, so new resources can use commandEndpoint(...)
// .createQuery(...) or .createMutation(...).
export function invoke<T = unknown>(
  command: CommandName,
  args?: NativeCommandInput,
): Promise<T> {
  return firstValueFrom(commandEndpoint<T>(command).execute(args));
}

export namespace commands {
${namespaces}
}
`;

if (process.argv.includes("--check")) {
  const existing = await readFile(outputPath, "utf8").catch(() => "");
  if (existing !== generated) {
    console.error("src/generated/native.ts is stale; run corepack pnpm@10.12.4 api:generate");
    process.exit(1);
  }
} else {
  await mkdir(resolve(root, "src/generated"), { recursive: true });
  await writeFile(outputPath, generated);
}
// todo(codegen): derive command names from Rust registration instead of maintaining a parallel list
// todo(codegen): generate command-specific input and output types from a native schema
