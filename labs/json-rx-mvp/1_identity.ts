import type {
  InstanceParameters,
  JsonPrimitive,
  ParameterBinding,
  ParametersSchema,
} from "./0_types";

function validateParameter(name: string, value: JsonPrimitive, schema: ParametersSchema): void {
  const parameter = schema.path?.[name] ?? schema.query?.[name];
  if (!parameter) throw new Error(`Unknown instance parameter: ${name}`);

  const valid =
    (parameter.type === "string" && typeof value === "string")
    || (parameter.type === "boolean" && typeof value === "boolean")
    || (parameter.type === "number" && typeof value === "number" && Number.isFinite(value))
    || (parameter.type === "integer" && typeof value === "number" && Number.isInteger(value));

  if (!valid) throw new Error(`Invalid ${parameter.type} instance parameter: ${name}`);
}

function encoded(value: JsonPrimitive): string {
  if (value === null) throw new Error("Instance parameters cannot be null");
  return encodeURIComponent(String(value));
}

export function instanceUrl(
  template: string,
  schema: ParametersSchema = {},
  parameters: InstanceParameters = {},
): string {
  const path = { ...parameters.path };
  let expanded = template.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = path[name];
    if (value === undefined) throw new Error(`Missing path instance parameter: ${name}`);
    validateParameter(name, value, schema);
    delete path[name];
    return encoded(value);
  });

  const remainingTemplates = expanded.match(/\{[^}]+\}/g);
  if (remainingTemplates) throw new Error(`Unresolved path parameters: ${remainingTemplates.join(", ")}`);
  if (Object.keys(path).length > 0) throw new Error(`Unused path parameters: ${Object.keys(path).join(", ")}`);

  const url = new URL(expanded);
  const query = { ...parameters.query };
  for (const [name, parameter] of Object.entries(schema.query ?? {})) {
    const supplied = query[name];
    const existing = url.searchParams.get(name);
    const value = supplied ?? (existing === null ? parameter.default : parseQuery(existing, parameter.type));
    if (value === undefined) continue;
    validateParameter(name, value, schema);
    url.searchParams.set(name, String(value));
    delete query[name];
  }
  if (Object.keys(query).length > 0) throw new Error(`Unknown query parameters: ${Object.keys(query).join(", ")}`);
  url.searchParams.sort();
  expanded = url.toString();
  return expanded;
}

function parseQuery(value: string, type: "boolean" | "integer" | "number" | "string"): JsonPrimitive {
  if (type === "string") return value;
  if (type === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
    throw new Error(`Invalid boolean query parameter: ${value}`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || (type === "integer" && !Number.isInteger(number))) {
    throw new Error(`Invalid ${type} query parameter: ${value}`);
  }
  return number;
}

function get(input: JsonValueForBinding, pointer: string): JsonPrimitive {
  if (!pointer.startsWith("$.")) throw new Error(`Only $.field bindings are supported: ${pointer}`);
  const segments = pointer.slice(2).split(".");
  let value: JsonValueForBinding = input;
  for (const segment of segments) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`Binding path did not resolve: ${pointer}`);
    }
    value = value[segment];
  }
  if (value === null || !["boolean", "number", "string"].includes(typeof value)) {
    throw new Error(`Binding must resolve to a primitive: ${pointer}`);
  }
  return value as JsonPrimitive;
}

type JsonValueForBinding = JsonPrimitive | JsonValueForBinding[] | { [key: string]: JsonValueForBinding };

export function bindParameters(
  bindings: { path?: Record<string, ParameterBinding>; query?: Record<string, ParameterBinding> },
  input: JsonValueForBinding,
): InstanceParameters {
  const bind = (entries: Record<string, ParameterBinding> = {}) => Object.fromEntries(
    Object.entries(entries).map(([name, binding]) => [
      name,
      typeof binding === "object" && binding !== null ? get(input, binding.get) : binding,
    ]),
  );

  return {
    path: bind(bindings.path),
    query: bind(bindings.query),
  };
}
