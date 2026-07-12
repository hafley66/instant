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
// Do not edit by hand. Run: npm run api:generate
import { nativeTransport } from "../reactive/nativeTransport";

export type CommandName =
${names.map((name) => `  | ${JSON.stringify(name)}`).join("\n")};

export function invoke<T = unknown>(
  command: CommandName,
  args?: Record<string, unknown>,
): Promise<T> {
  return nativeTransport.invoke<T>(command, args);
}

export namespace commands {
${namespaces}
}
`;

if (process.argv.includes("--check")) {
  const existing = await readFile(outputPath, "utf8").catch(() => "");
  if (existing !== generated) {
    console.error("src/generated/native.ts is stale; run npm run api:generate");
    process.exit(1);
  }
} else {
  await mkdir(resolve(root, "src/generated"), { recursive: true });
  await writeFile(outputPath, generated);
}
// todo(codegen): derive command names from Rust registration instead of maintaining a parallel list
// todo(codegen): generate command-specific input and output types from a native schema
