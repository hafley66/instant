import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import {
  listen as tauriListen,
  type EventCallback,
  type UnlistenFn,
} from "@tauri-apps/api/event";
import type { EndpointResponse, Serializable } from "@hafley66/signals";
import { Observable } from "rxjs";
import type { RequestTransport } from "./0_requestTransport";
import { wsTransport } from "./wsTransport";

export type NativeCommandInput = Record<string, unknown> | undefined;
export type NativeUnlistenFn = UnlistenFn;

// Two implementations of one command/event edge: Tauri IPC inside the app,
// JSON-RPC over loopback WebSocket in a plain browser (Playwright, instant-serve).
export interface NativeTransport {
  invoke<T>(command: string, args?: NativeCommandInput): Promise<T>;
  listen<T>(event: string, cb: (payload: T) => void): Promise<NativeUnlistenFn>;
}

export function tauriTransport(): NativeTransport {
  return {
    invoke<T>(command: string, args?: NativeCommandInput): Promise<T> {
      return tauriInvoke<T>(command, args);
    },
    listen<T>(event: string, cb: (payload: T) => void): Promise<NativeUnlistenFn> {
      return tauriListen<T>(event, ({ payload }) => cb(payload));
    },
  };
}

export const DEFAULT_WS_URL = "ws://127.0.0.1:47777";

export function hasTauriInternals(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function wsUrl(): string {
  return typeof location !== "undefined"
    ? new URLSearchParams(location.search).get("ws") ?? DEFAULT_WS_URL
    : DEFAULT_WS_URL;
}

// One connection per page: the ws instance is memoized by url so repeated
// calls share the socket, pending map, and event listeners.
const wsTransports = new Map<string, NativeTransport>();

export function pickTransport(): NativeTransport {
  if (hasTauriInternals()) return tauriTransport();
  const url = wsUrl();
  let transport = wsTransports.get(url);
  if (!transport) wsTransports.set(url, (transport = wsTransport(url)));
  return transport;
}


export function nativeCommandUrl(command: string): string {
  return `tauri://instant/commands/${encodeURIComponent(command)}`;
}

function commandFromRequest(request: { url: string; method: string }): string {
  const url = new URL(request.url);
  if (url.protocol !== "tauri:" || url.host !== "instant" || request.method !== "POST") {
    throw new Error(`unsupported native request: ${request.method} ${request.url}`);
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 2 || segments[0] !== "commands" || !segments[1]) {
    throw new Error(`unsupported native request path: ${request.url}`);
  }
  return decodeURIComponent(segments[1]);
}

function commandArgs(body: Serializable | undefined): NativeCommandInput {
  if (body === undefined || body === null) return undefined;
  if (Array.isArray(body) || typeof body !== "object") {
    throw new Error("native command arguments must be an object");
  }
  return body as Record<string, unknown>;
}

// The only Tauri application-data edge. Generated command endpoints construct
// POST tauri://instant/commands/<name> requests and may be replaced by an HTTP
// transport without changing any domain call site.
export const nativeRequestTransport: RequestTransport = async (request) => {
  const command = commandFromRequest(request);
  const args = commandArgs(request.body);
  const body = await pickTransport().invoke<Serializable>(command, args);
  return { status: 200, body } satisfies EndpointResponse;
};

// Tauri event ownership is similarly isolated here: the transport chosen by
// pickTransport receives them. Callers retain the returned teardown function.
export function listenNativeEvent<Payload>(
  event: string,
  handler: EventCallback<Payload>,
): Promise<NativeUnlistenFn> {
  return pickTransport().listen<Payload>(event, (payload) =>
    handler({ event, id: 0, payload }),
  );
}

// Hot native events become a teardown-aware Observable at the adapter. The
// subscription owns both the late async registration and the native unlisten.
export function nativeEvent$<Payload>(event: string): Observable<Payload> {
  return new Observable<Payload>((subscriber) => {
    let unlisten: NativeUnlistenFn | undefined;
    void listenNativeEvent<Payload>(event, ({ payload }) => subscriber.next(payload))
      .then((nextUnlisten) => {
        if (subscriber.closed) nextUnlisten();
        else unlisten = nextUnlisten;
      })
      .catch((error: unknown) => subscriber.error(error));
    return () => unlisten?.();
  });
}
