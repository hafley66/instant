// Generated from openapi/instant-http.json by scripts/generate-api.mjs.
// Do not edit by hand. Run: npm run api:generate
import type { EndpointConfig, Serializable } from "@hafley66/signals";

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

    export interface Rule {
      id: string;
      host: string;
      url?: string;
      mode: "textnodes" | "selector" | "netcapture";
      selector?: string;
      regex?: string;
      captures?: Record<string, string>;
      schedule?: "passive" | { "intervalMin": number };
      action: "report" | "notify";
      enabled?: boolean;
    }

    export interface ServerConfig {
      revision?: number;
      rules: components.schemas.Rule[];
    }

    export interface ActivityEvent {
      kind: string;
      url: string;
      title: string;
      text: string;
    }

    export interface RuleMatchEvent {
      type: "rulematch";
      ruleId: string;
      url: string;
      ts: number;
      matches: Record<string, string>[];
    }

    export interface EditorEvent {
      type: "editor";
      event: "focus" | "cursor" | "save";
      path: string;
      languageId?: string;
      workspace?: string;
      line?: number;
      ts: number;
    }

    export type IngestEvent = components.schemas.ActivityEvent | components.schemas.RuleMatchEvent | components.schemas.EditorEvent;
  }
}

export namespace paths {
  export namespace worktrees {
    export const method = "GET";
    export const url = "http://127.0.0.1:7748" + "/worktrees";
    export type Input = void;
    export type Output = components.schemas.WorktreeRow[];

    export const endpoint: EndpointConfig<Input, Output> = {
      request: (_input) => ({ url, method }),
      decode: (response) => {
        if (response.status < 200 || response.status >= 300) {
          throw new HttpStatusError(response.status);
        }
        return response.body as unknown as Output;
      },
    };
  }

  export namespace events {
    export const method = "GET";
    export const url = "http://127.0.0.1:7748" + "/events";
    export type Input = void;
    export type Output = string;

    export const connect = (EventSourceImpl: typeof EventSource = EventSource) =>
      new EventSourceImpl(url);
    export const endpoint: EndpointConfig<Input, Output> = {
      request: (_input) => ({ url, method }),
      decode: (response) => {
        if (response.status < 200 || response.status >= 300) {
          throw new HttpStatusError(response.status);
        }
        return response.body as unknown as Output;
      },
    };
  }

  export namespace activityConfig {
    export const method = "GET";
    export const url = "http://127.0.0.1:8787" + "/config";
    export type Input = void;
    export type Output = components.schemas.ServerConfig;

    export const endpoint: EndpointConfig<Input, Output> = {
      request: (_input) => ({ url, method }),
      decode: (response) => {
        if (response.status < 200 || response.status >= 300) {
          throw new HttpStatusError(response.status);
        }
        return response.body as unknown as Output;
      },
    };
  }

  export namespace activityIngest {
    export const method = "POST";
    export const url = "http://127.0.0.1:8787" + "/ingest";
    export type Input = components.schemas.IngestEvent;
    export type Output = string;

    export const endpoint: EndpointConfig<Input, Output> = {
      request: (input) => ({ url, method, body: input as unknown as Serializable }),
      decode: (response) => {
        if (response.status < 200 || response.status >= 300) {
          throw new HttpStatusError(response.status);
        }
        return response.body as unknown as Output;
      },
    };
  }
}
