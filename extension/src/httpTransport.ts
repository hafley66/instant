import type { EndpointConfig, EndpointResponse, Serializable } from "@hafley66/signals";

declare const __INSTANT_ACTIVITY_ORIGIN__: string;

export function activityUrl(path: string): string {
  return requestUrl(`http://127.0.0.1:8787${path}`);
}

function requestUrl(url: string): string {
  if (!url.startsWith("http://127.0.0.1:8787/")) return url;
  const origin = typeof __INSTANT_ACTIVITY_ORIGIN__ === "string"
    ? __INSTANT_ACTIVITY_ORIGIN__
    : "http://127.0.0.1:8787";
  const parsed = new URL(url);
  return `${origin}${parsed.pathname}${parsed.search}`;
}

export async function executeHttp<Input, Output>(
  config: EndpointConfig<Input, Output>,
  input: Input,
): Promise<Output> {
  const request = config.request(input);
  const response = await globalThis.fetch(requestUrl(request.url), {
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
