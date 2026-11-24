import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const specPath = resolve(root, "openapi/instant-http.json");
const outputPath = resolve(root, "src/generated/api.ts");
const spec = JSON.parse(await readFile(specPath, "utf8"));

const typeFor = (schema) => {
  if (!Object.keys(schema).length) return "unknown";
  if (schema.$ref) return `components.schemas.${schema.$ref.split("/").at(-1)}`;
  if (schema.oneOf) return schema.oneOf.map(typeFor).join(" | ");
  if (schema.type === "array") return `${typeFor(schema.items)}[]`;
  if (schema.enum) return schema.enum.map(JSON.stringify).join(" | ");
  if (schema.type === "object" && schema.additionalProperties) {
    return `Record<string, ${typeFor(schema.additionalProperties)}>`;
  }
  if (schema.type === "object") {
    const required = new Set(schema.required ?? []);
    const fields = Object.entries(schema.properties ?? {}).map(([name, value]) =>
      `${JSON.stringify(name)}${required.has(name) ? "" : "?"}: ${typeFor(value)}`
    );
    return `{ ${fields.join("; ")} }`;
  }
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "number" || schema.type === "integer") return "number";
  return "string";
};

const schemas = Object.entries(spec.components?.schemas ?? {}).map(([name, schema]) => {
  const required = new Set(schema.required ?? []);
  if (schema.type !== "object" || schema.oneOf) {
    return `    export type ${name} = ${typeFor(schema)};`;
  }
  const fields = Object.entries(schema.properties ?? {})
    .map(([field, value]) => `      ${field}${required.has(field) ? "" : "?"}: ${typeFor(value)};`)
    .join("\n");
  return `    export interface ${name} {\n${fields}\n    }`;
}).join("\n\n");

const baseUrl = spec.servers?.[0]?.url;
if (!baseUrl) throw new Error("OpenAPI spec requires servers[0].url");

const operations = [];
const operationNames = [];
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
    const requestSchema = operation.requestBody?.content?.["application/json"]?.schema;
    const input = requestSchema ? typeFor(requestSchema) : "void";
    const inputName = requestSchema ? "input" : "_input";
    const operationBaseUrl = operation.servers?.[0]?.url ?? baseUrl;
    const requestBody = requestSchema ? ", body: input as unknown as Serializable" : "";
    const inputBack = requestSchema ? "request.body as unknown as Input" : "undefined";
    const sse = mediaType === "text/event-stream"
      ? `\n    export const connect = (EventSourceImpl: typeof EventSource = EventSource) =>\n      new EventSourceImpl(url);`
      : "";
    operations.push(`  export namespace ${name} {
    export const method = "${method.toUpperCase()}";
    export const url = ${JSON.stringify(operationBaseUrl)} + ${JSON.stringify(path)};
    export type Input = ${input};
    export type Output = ${output};
    export const meta = {
      operationId: ${JSON.stringify(name)},
      method,
      path: ${JSON.stringify(path)},
      server: ${JSON.stringify(operationBaseUrl)},
      responseMediaType: ${JSON.stringify(mediaType)},
      operation: spec.paths[${JSON.stringify(path)}].${method},
    } as const;
${sse}
    export const endpoint: Operation<Input, Output, typeof meta> = {
      meta,
      request: (${inputName}) => ({ url, method${requestBody} }),
      input: (${requestSchema ? "request" : "_request"}) => ${inputBack},
      decode: (response) => {
        if (response.status < 200 || response.status >= 300) {
          throw new HttpStatusError(response.status);
        }
        return response.body as unknown as Output;
      },
      encode: (output) => ({
        status: 200,
        headers: { "content-type": meta.responseMediaType },
        body: output as unknown as Serializable,
      }),
    };
  }`);
    operationNames.push(name);
  }
}

const generated = `// Generated from openapi/instant-http.json by scripts/generate-api.mjs.
// Do not edit by hand. Run: corepack pnpm@10.12.4 api:generate
import type { EndpointConfig, EndpointRequest, EndpointResponse, Serializable } from "@hafley66/signals";

export const baseUrl = ${JSON.stringify(baseUrl)};

// The source document, kept whole so a later generator or test tool can read it.
export const spec = ${JSON.stringify(spec, null, 2)} as const;

// request/decode run in the client; input/encode are their inverses, for a
// tool that stands in for the server or reads a recorded exchange.
export type Operation<I, O, M = unknown> = EndpointConfig<I, O> & {
  meta: M;
  input: (request: EndpointRequest) => I;
  encode: (output: O) => EndpointResponse;
};

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

export const operations = {
${operationNames.map((name) => `  ${name}: paths.${name}.endpoint,`).join("\n")}
};
`;

if (process.argv.includes("--check")) {
  const existing = await readFile(outputPath, "utf8").catch(() => "");
  if (existing !== generated) {
    console.error("src/generated/api.ts is stale; run corepack pnpm@10.12.4 api:generate");
    process.exit(1);
  }
} else {
  await mkdir(resolve(root, "src/generated"), { recursive: true });
  await writeFile(outputPath, generated);
}
// todo(codegen): generate parameters, error responses, and media-type decoders
