import {
  Endpoint,
  type EndpointConfig,
  type EndpointTransport,
} from "@hafley66/signals";

// One serializable request/response shape for loopback HTTP, the current Tauri
// adapter, and test transports. Resource ownership remains in Endpoint's
// createQuery/createMutation primitives rather than in this constructor.
export type RequestTransport = EndpointTransport;

export function createRequestEndpoint<Input, Output>(
  config: EndpointConfig<Input, Output>,
  transport: RequestTransport,
): Endpoint<Input, Output> {
  return new Endpoint(config, transport);
}
