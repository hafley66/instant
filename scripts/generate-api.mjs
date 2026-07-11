import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const specPath = resolve(root, "openapi/instant-http.json");
const outputPath = resolve(root, "src/generated/api.ts");
const spec = JSON.parse(await readFile(specPath, "utf8"));

const typeFor = (schema) => {
  if (schema.$ref) return `components.schemas.${schema.$ref.split("/").at(-1)}`;
  if (schema.type === "array") return `${typeFor(schema.items)}[]`;
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "number" || schema.type === "integer") return "number";
  return "string";
};

const schemas = Object.entries(spec.components?.schemas ?? {}).map(([name, schema]) => {
  const required = new Set(schema.required ?? []);
  const fields = Object.entries(schema.properties ?? {})
    .map(([field, value]) => `      ${field}${required.has(field) ? "" : "?"}: ${typeFor(value)};`)
    .join("\n");
  return `    export interface ${name} {\n${fields}\n    }`;
}).join("\n\n");

const baseUrl = spec.servers?.[0]?.url;
if (!baseUrl) throw new Error("OpenAPI spec requires servers[0].url");

const operations = [];
for (const [path, item] of Object.entries(spec.paths ?? {})) {
  for (const [method, operation] of Object.entries(item)) {
    const name = operation.operationId;
    if (!name) throw new Error(`${method.toUpperCase()} ${path} needs operationId`);
    const response = operation.responses?.["200"];
    const content = response?.content ?? {};
    const mediaType = Object.keys(content)[0];
    const schema = content[mediaType]?.schema;
    if (!schema) throw new Error(`${name} needs a 200 response schema`);
    const output = typeFor(schema);
    const sse = mediaType === "text/event-stream"
      ? `\n    export const connect = (EventSourceImpl: typeof EventSource = EventSource) =>\n      new EventSourceImpl(url);`
      : "";
    operations.push(`  export namespace ${name} {
    export const method = "${method.toUpperCase()}";
    export const url = baseUrl + ${JSON.stringify(path)};
    export type Output = ${output};
${sse}
    export const endpoint = (transport: EndpointTransport) =>
      new Endpoint<void, Output>(
        {
          request: () => ({ url, method }),
          decode: (response) => {
            if (response.status < 200 || response.status >= 300) {
              throw new HttpStatusError(response.status);
            }
            return response.body as unknown as Output;
          },
        },
        transport,
      );
  }`);
  }
}

const generated = `// Generated from openapi/instant-http.json by scripts/generate-api.mjs.
// Do not edit by hand. Run: npm run api:generate
import { Endpoint, type EndpointTransport } from "@hafley66/signals";

export const baseUrl = ${JSON.stringify(baseUrl)};

export class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(\`HTTP \${status}\`);
  }
}

export namespace components {
  export namespace schemas {
${schemas}
  }
}

export namespace paths {
${operations.join("\n\n")}
}
`;

if (process.argv.includes("--check")) {
  const existing = await readFile(outputPath, "utf8").catch(() => "");
  if (existing !== generated) {
    console.error("src/generated/api.ts is stale; run npm run api:generate");
    process.exit(1);
  }
} else {
  await mkdir(resolve(root, "src/generated"), { recursive: true });
  await writeFile(outputPath, generated);
}
// todo(codegen): generate request bodies, parameters, error responses, and media-type decoders
// todo(codegen): migrate the activity :8787 API and extension clients into this specification
