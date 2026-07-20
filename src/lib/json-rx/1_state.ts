import type { JsonPatchOperation, JsonValue, State, StateUpdate } from "./0_types";

function clone<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function decodePathPart(part: string): string {
  return part.split("~1").join("/").split("~0").join("~");
}

function pathParts(path: string): string[] {
  if (path === "") return [];
  if (!path.startsWith("/")) throw new Error(`JSON Patch path must start with /: ${path}`);
  return path.slice(1).split("/").map(decodePathPart);
}

function setAtPath(root: JsonValue, parts: string[], value: JsonValue): JsonValue {
  if (parts.length === 0) return clone(value);
  const [part, ...rest] = parts;
  if (Array.isArray(root)) {
    const index = part === "-" ? root.length : Number(part);
    if (!Number.isInteger(index) || index < 0 || index > root.length) {
      throw new Error(`Invalid array path segment: ${part}`);
    }
    const next = root.slice();
    if (rest.length === 0) next[index] = clone(value);
    else next[index] = setAtPath(next[index], rest, value);
    return next;
  }
  if (root === null || typeof root !== "object") throw new Error(`Cannot set path through ${part}`);
  return { ...root, [part]: rest.length === 0 ? clone(value) : setAtPath(root[part] ?? null, rest, value) };
}

function removeAtPath(root: JsonValue, parts: string[]): JsonValue {
  if (parts.length === 0) throw new Error("Cannot remove the root state");
  const [part, ...rest] = parts;
  if (Array.isArray(root)) {
    const index = Number(part);
    if (!Number.isInteger(index) || index < 0 || index >= root.length) {
      throw new Error(`Invalid array path segment: ${part}`);
    }
    const next = root.slice();
    if (rest.length === 0) next.splice(index, 1);
    else next[index] = removeAtPath(next[index], rest);
    return next;
  }
  if (root === null || typeof root !== "object") throw new Error(`Cannot remove path through ${part}`);
  if (rest.length === 0) {
    const next = { ...root };
    delete next[part];
    return next;
  }
  return { ...root, [part]: removeAtPath(root[part], rest) };
}

export function applyJsonPatch(state: State, patch: JsonPatchOperation[]): State {
  return patch.reduce<JsonValue>((current, operation) => {
    const parts = pathParts(operation.path);
    if (operation.op === "remove") return removeAtPath(current, parts);
    return setAtPath(current, parts, operation.value);
  }, clone(state)) as State;
}

export function applyStateUpdate(state: State, update: StateUpdate): State {
  if (update.op === "replace") return clone(update.state);
  if (update.op === "patch") return applyJsonPatch(state, update.patch);
  return setAtPath(state, pathParts(update.path), update.value) as State;
}

export function applyStateUpdates(state: State, updates: StateUpdate[] = []): State {
  return updates.reduce(applyStateUpdate, state);
}
