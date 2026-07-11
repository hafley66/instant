import type { EndpointConfig, EndpointResponse, Serializable } from "@hafley66/signals";

export async function executeHttp<Input, Output>(
  config: EndpointConfig<Input, Output>,
  input: Input,
  urlOverride?: string,
): Promise<Output> {
  const request = config.request(input);
  const response = await globalThis.fetch(urlOverride ?? request.url, {
    method: request.method,
    headers: { "Content-Type": "application/json", ...request.headers },
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
  });
  const text = await response.text();
  const body: Serializable = response.headers.get("content-type")?.includes("application/json") && text
    ? JSON.parse(text) as Serializable
    : text;
  return config.decode({ status: response.status, body } satisfies EndpointResponse);
}
