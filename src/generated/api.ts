// Generated from openapi/instant-http.json by scripts/generate-api.mjs.
// Do not edit by hand. Run: npm run api:generate
import { Endpoint, type EndpointTransport } from "@hafley66/signals";

export const baseUrl = "http://127.0.0.1:7748";

export class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

export namespace components {
  export namespace schemas {
    export interface WorktreeRow {
      origin: string;
      clone: string;
      worktree: string;
      branch: string;
      head: string;
      is_main: boolean;
      dirty: boolean;
    }
  }
}

export namespace paths {
  export namespace worktrees {
    export const method = "GET";
    export const url = baseUrl + "/worktrees";
    export type Output = components.schemas.WorktreeRow[];

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
  }

  export namespace events {
    export const method = "GET";
    export const url = baseUrl + "/events";
    export type Output = string;

    export const connect = (EventSourceImpl: typeof EventSource = EventSource) =>
      new EventSourceImpl(url);
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
  }
}
