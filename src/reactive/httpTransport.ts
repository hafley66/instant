import type {
  EndpointConfig,
  EndpointResponse,
  Serializable,
} from "@hafley66/signals";
import { runtimePorts } from "./ports";
import { createRequestEndpoint, type RequestTransport } from "./0_requestTransport";

export const HTTP_TIMEOUT_MS = 2000;

// The only native HTTP edge in the application. Domain code consumes the
// OpenAPI-generated Endpoints in src/generated/api.ts, never fetch directly.
export const httpTransport: RequestTransport = async (request) => {
  const response = await globalThis.fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    signal: runtimePorts.abortSignal(HTTP_TIMEOUT_MS),
  });
  let body: Serializable = null;
  const text = await response.text();
  if (text) body = JSON.parse(text) as Serializable;
  return { status: response.status, body } satisfies EndpointResponse;
};

export const createHttpEndpoint = <Input, Output>(
  config: EndpointConfig<Input, Output>,
  transport: RequestTransport = httpTransport,
) => createRequestEndpoint(config, transport);
// todo(http): support media-type-aware decoding instead of assuming JSON for every response
// todo(test): verify abort, invalid JSON, empty body, and non-2xx transport behavior
