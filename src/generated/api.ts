// Generated from openapi/instant-http.json by scripts/generate-api.mjs.
// Do not edit by hand. Run: corepack pnpm@10.12.4 api:generate
import type { EndpointConfig, EndpointRequest, EndpointResponse, Serializable } from "@hafley66/signals";

export const baseUrl = "http://127.0.0.1:7748";

// The source document, kept whole so a later generator or test tool can read it.
export const spec = {
  "openapi": "3.0.3",
  "info": {
    "title": "Instant HTTP APIs",
    "version": "1.0.0"
  },
  "servers": [
    {
      "url": "http://127.0.0.1:7748",
      "description": "local ghcache daemon"
    }
  ],
  "paths": {
    "/worktrees": {
      "get": {
        "operationId": "worktrees",
        "responses": {
          "200": {
            "description": "Current git worktree snapshot",
            "content": {
              "application/json": {
                "schema": {
                  "type": "array",
                  "items": {
                    "$ref": "#/components/schemas/WorktreeRow"
                  }
                }
              }
            }
          }
        }
      }
    },
    "/events": {
      "get": {
        "operationId": "events",
        "responses": {
          "200": {
            "description": "ghcache change stream",
            "content": {
              "text/event-stream": {
                "schema": {
                  "type": "string"
                }
              }
            }
          }
        }
      }
    },
    "/config": {
      "get": {
        "operationId": "activityConfig",
        "servers": [
          {
            "url": "http://127.0.0.1:8787"
          }
        ],
        "responses": {
          "200": {
            "description": "Authoritative browser extraction rules",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/ServerConfig"
                }
              }
            }
          }
        }
      }
    },
    "/heartbeat": {
      "post": {
        "operationId": "activityHeartbeat",
        "servers": [
          {
            "url": "http://127.0.0.1:8787"
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/WatcherHeartbeat"
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Extension watcher status recorded",
            "content": {
              "text/plain": {
                "schema": {
                  "type": "string"
                }
              }
            }
          }
        }
      }
    },
    "/ingest": {
      "post": {
        "operationId": "activityIngest",
        "servers": [
          {
            "url": "http://127.0.0.1:8787"
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/IngestEvent"
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Event accepted or filtered",
            "content": {
              "text/plain": {
                "schema": {
                  "type": "string"
                }
              }
            }
          }
        }
      }
    }
  },
  "components": {
    "schemas": {
      "WorktreeRow": {
        "type": "object",
        "required": [
          "origin",
          "clone",
          "worktree",
          "branch",
          "head",
          "is_main",
          "dirty"
        ],
        "properties": {
          "origin": {
            "type": "string"
          },
          "clone": {
            "type": "string"
          },
          "worktree": {
            "type": "string"
          },
          "branch": {
            "type": "string"
          },
          "head": {
            "type": "string"
          },
          "is_main": {
            "type": "boolean"
          },
          "dirty": {
            "type": "boolean"
          }
        }
      },
      "Rule": {
        "type": "object",
        "required": [
          "id",
          "host",
          "mode"
        ],
        "properties": {
          "id": {
            "type": "string"
          },
          "host": {
            "type": "string"
          },
          "url": {
            "type": "string"
          },
          "mode": {
            "type": "string",
            "enum": [
              "textnodes",
              "selector",
              "netcapture"
            ]
          },
          "selector": {
            "type": "string"
          },
          "regex": {
            "type": "string"
          },
          "captures": {
            "type": "object",
            "additionalProperties": {
              "type": "string"
            }
          },
          "request": {
            "type": "object",
            "properties": {
              "methods": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "url": {
                "type": "string"
              }
            }
          },
          "response": {
            "type": "object",
            "properties": {
              "extract": {
                "type": "object",
                "additionalProperties": {
                  "type": "string"
                }
              }
            }
          },
          "emit": {
            "type": "object",
            "required": [
              "stream"
            ],
            "properties": {
              "stream": {
                "type": "string"
              },
              "schema": {
                "$ref": "#/components/schemas/JsonSchema"
              }
            }
          },
          "schedule": {
            "oneOf": [
              {
                "type": "string",
                "enum": [
                  "passive"
                ]
              },
              {
                "type": "object",
                "required": [
                  "intervalMin"
                ],
                "properties": {
                  "intervalMin": {
                    "type": "number"
                  },
                  "effects": {
                    "type": "array",
                    "items": {
                      "$ref": "#/components/schemas/RuleEffect"
                    }
                  }
                }
              }
            ]
          },
          "enabled": {
            "type": "boolean"
          }
        }
      },
      "WatcherHeartbeat": {
        "type": "object",
        "required": [
          "revision",
          "rulesCount"
        ],
        "properties": {
          "revision": {
            "type": "integer"
          },
          "rulesCount": {
            "type": "integer"
          }
        }
      },
      "RuleEffect": {
        "type": "object",
        "required": [
          "op"
        ],
        "properties": {
          "id": {
            "type": "string"
          },
          "op": {
            "type": "string"
          },
          "input": {}
        }
      },
      "ServerConfig": {
        "type": "object",
        "required": [
          "rules"
        ],
        "properties": {
          "revision": {
            "type": "integer"
          },
          "rules": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/Rule"
            }
          }
        }
      },
      "JsonSchema": {
        "type": "object",
        "additionalProperties": true,
        "properties": {
          "type": {
            "oneOf": [
              {
                "type": "string"
              },
              {
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            ]
          },
          "title": {
            "type": "string"
          },
          "description": {
            "type": "string"
          },
          "properties": {
            "type": "object",
            "additionalProperties": {
              "$ref": "#/components/schemas/JsonSchema"
            }
          },
          "items": {
            "$ref": "#/components/schemas/JsonSchema"
          },
          "minimum": {
            "type": "number"
          },
          "maximum": {
            "type": "number"
          },
          "format": {
            "type": "string"
          }
        }
      },
      "ActivityEvent": {
        "type": "object",
        "required": [
          "kind",
          "url",
          "title",
          "text"
        ],
        "properties": {
          "kind": {
            "type": "string"
          },
          "url": {
            "type": "string"
          },
          "title": {
            "type": "string"
          },
          "text": {
            "type": "string"
          }
        }
      },
      "RuleMatchEvent": {
        "type": "object",
        "required": [
          "type",
          "ruleId",
          "url",
          "ts",
          "matches"
        ],
        "properties": {
          "type": {
            "type": "string",
            "enum": [
              "rulematch"
            ]
          },
          "ruleId": {
            "type": "string"
          },
          "url": {
            "type": "string"
          },
          "ts": {
            "type": "integer"
          },
          "matches": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": {}
            }
          },
          "stream": {
            "type": "string"
          },
          "schema": {
            "$ref": "#/components/schemas/JsonSchema"
          }
        }
      },
      "EditorEvent": {
        "type": "object",
        "required": [
          "type",
          "event",
          "path",
          "ts"
        ],
        "properties": {
          "type": {
            "type": "string",
            "enum": [
              "editor"
            ]
          },
          "event": {
            "type": "string",
            "enum": [
              "focus",
              "cursor",
              "save"
            ]
          },
          "path": {
            "type": "string"
          },
          "languageId": {
            "type": "string"
          },
          "workspace": {
            "type": "string"
          },
          "line": {
            "type": "integer"
          },
          "ts": {
            "type": "integer"
          }
        }
      },
      "IngestEvent": {
        "oneOf": [
          {
            "$ref": "#/components/schemas/ActivityEvent"
          },
          {
            "$ref": "#/components/schemas/RuleMatchEvent"
          },
          {
            "$ref": "#/components/schemas/EditorEvent"
          }
        ]
      }
    }
  }
} as const;

// request/decode run in the client; input/encode are their inverses, for a
// tool that stands in for the server or reads a recorded exchange.
export type Operation<I, O, M = unknown> = EndpointConfig<I, O> & {
  meta: M;
  input: (request: EndpointRequest) => I;
  encode: (output: O) => EndpointResponse;
};

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
      request?: { "methods"?: string[]; "url"?: string };
      response?: { "extract"?: Record<string, string> };
      emit?: { "stream": string; "schema"?: components.schemas.JsonSchema };
      schedule?: "passive" | { "intervalMin": number; "effects"?: components.schemas.RuleEffect[] };
      enabled?: boolean;
    }

    export interface WatcherHeartbeat {
      revision: number;
      rulesCount: number;
    }

    export interface RuleEffect {
      id?: string;
      op: string;
      input?: unknown;
    }

    export interface ServerConfig {
      revision?: number;
      rules: components.schemas.Rule[];
    }

    export interface JsonSchema {
      type?: string | string[];
      title?: string;
      description?: string;
      properties?: Record<string, components.schemas.JsonSchema>;
      items?: components.schemas.JsonSchema;
      minimum?: number;
      maximum?: number;
      format?: string;
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
      matches: Record<string, unknown>[];
      stream?: string;
      schema?: components.schemas.JsonSchema;
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
    export const meta = {
      operationId: "worktrees",
      method,
      path: "/worktrees",
      server: "http://127.0.0.1:7748",
      responseMediaType: "application/json",
      operation: spec.paths["/worktrees"].get,
    } as const;

    export const endpoint: Operation<Input, Output, typeof meta> = {
      meta,
      request: (_input) => ({ url, method }),
      input: (_request) => undefined,
      decode: (response) => {
        if (response.status < 200 || response.status >= 300) {
          throw new HttpStatusError(response.status);
        }
        return response.body as unknown as Output;
      },
      encode: (output) => ({
        status: 200,
        headers: { "content-type": meta.responseMediaType },
        body: output as unknown as Serializable,
      }),
    };
  }

  export namespace events {
    export const method = "GET";
    export const url = "http://127.0.0.1:7748" + "/events";
    export type Input = void;
    export type Output = string;
    export const meta = {
      operationId: "events",
      method,
      path: "/events",
      server: "http://127.0.0.1:7748",
      responseMediaType: "text/event-stream",
      operation: spec.paths["/events"].get,
    } as const;

    export const connect = (EventSourceImpl: typeof EventSource = EventSource) =>
      new EventSourceImpl(url);
    export const endpoint: Operation<Input, Output, typeof meta> = {
      meta,
      request: (_input) => ({ url, method }),
      input: (_request) => undefined,
      decode: (response) => {
        if (response.status < 200 || response.status >= 300) {
          throw new HttpStatusError(response.status);
        }
        return response.body as unknown as Output;
      },
      encode: (output) => ({
        status: 200,
        headers: { "content-type": meta.responseMediaType },
        body: output as unknown as Serializable,
      }),
    };
  }

  export namespace activityConfig {
    export const method = "GET";
    export const url = "http://127.0.0.1:8787" + "/config";
    export type Input = void;
    export type Output = components.schemas.ServerConfig;
    export const meta = {
      operationId: "activityConfig",
      method,
      path: "/config",
      server: "http://127.0.0.1:8787",
      responseMediaType: "application/json",
      operation: spec.paths["/config"].get,
    } as const;

    export const endpoint: Operation<Input, Output, typeof meta> = {
      meta,
      request: (_input) => ({ url, method }),
      input: (_request) => undefined,
      decode: (response) => {
        if (response.status < 200 || response.status >= 300) {
          throw new HttpStatusError(response.status);
        }
        return response.body as unknown as Output;
      },
      encode: (output) => ({
        status: 200,
        headers: { "content-type": meta.responseMediaType },
        body: output as unknown as Serializable,
      }),
    };
  }

  export namespace activityHeartbeat {
    export const method = "POST";
    export const url = "http://127.0.0.1:8787" + "/heartbeat";
    export type Input = components.schemas.WatcherHeartbeat;
    export type Output = string;
    export const meta = {
      operationId: "activityHeartbeat",
      method,
      path: "/heartbeat",
      server: "http://127.0.0.1:8787",
      responseMediaType: "text/plain",
      operation: spec.paths["/heartbeat"].post,
    } as const;

    export const endpoint: Operation<Input, Output, typeof meta> = {
      meta,
      request: (input) => ({ url, method, body: input as unknown as Serializable }),
      input: (request) => request.body as unknown as Input,
      decode: (response) => {
        if (response.status < 200 || response.status >= 300) {
          throw new HttpStatusError(response.status);
        }
        return response.body as unknown as Output;
      },
      encode: (output) => ({
        status: 200,
        headers: { "content-type": meta.responseMediaType },
        body: output as unknown as Serializable,
      }),
    };
  }

  export namespace activityIngest {
    export const method = "POST";
    export const url = "http://127.0.0.1:8787" + "/ingest";
    export type Input = components.schemas.IngestEvent;
    export type Output = string;
    export const meta = {
      operationId: "activityIngest",
      method,
      path: "/ingest",
      server: "http://127.0.0.1:8787",
      responseMediaType: "text/plain",
      operation: spec.paths["/ingest"].post,
    } as const;

    export const endpoint: Operation<Input, Output, typeof meta> = {
      meta,
      request: (input) => ({ url, method, body: input as unknown as Serializable }),
      input: (request) => request.body as unknown as Input,
      decode: (response) => {
        if (response.status < 200 || response.status >= 300) {
          throw new HttpStatusError(response.status);
        }
        return response.body as unknown as Output;
      },
      encode: (output) => ({
        status: 200,
        headers: { "content-type": meta.responseMediaType },
        body: output as unknown as Serializable,
      }),
    };
  }
}

export const operations = {
  worktrees: paths.worktrees.endpoint,
  events: paths.events.endpoint,
  activityConfig: paths.activityConfig.endpoint,
  activityHeartbeat: paths.activityHeartbeat.endpoint,
  activityIngest: paths.activityIngest.endpoint,
};
