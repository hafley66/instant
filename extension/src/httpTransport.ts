import type { EndpointConfig, EndpointResponse, Serializable } from "@hafley66/signals";

export async function executeHttp<Input, Output>(
  config: EndpointConfig<Input, Output>,
  input: Input,
): Promise<Output> {
  const request = config.request(input);
  const response = await globalThis.fetch(request.url, {
    method: request.method,
    headers: { "Content-Type": "application/json", ...request.headers },
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    cache: "no-store",
  });
  const text = await response.text();
  let body: Serializable = text;
  if (response.headers.get("content-type")?.includes("application/json") && text) {
    body = JSON.parse(text) as Serializable;
  }
  return config.decode({ status: response.status, body } satisfies EndpointResponse);
}
