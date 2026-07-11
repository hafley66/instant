import type {
  EndpointConfig,
  EndpointResponse,
  EndpointTransport,
  Serializable,
} from "@hafley66/signals";
import { Endpoint } from "@hafley66/signals";
import { runtimePorts } from "./ports";

export const HTTP_TIMEOUT_MS = 2000;

// The only native HTTP edge in the application. Domain code consumes the
// OpenAPI-generated Endpoints in src/generated/api.ts, never fetch directly.
export const httpTransport: EndpointTransport = async (request) => {
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
  transport: EndpointTransport = httpTransport,
) => new Endpoint(config, transport);
// todo(http): support media-type-aware decoding instead of assuming JSON for every response
// todo(test): verify abort, invalid JSON, empty body, and non-2xx transport behavior
