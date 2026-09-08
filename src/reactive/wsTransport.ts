import type {
  NativeCommandInput,
  NativeTransport,
  NativeUnlistenFn,
} from "./nativeTransport";

// JSON-RPC 2.0 over one WebSocket: invoke = request/response pair, listen = one
// "events" subscription fanned out by event name. Dials lazily on first frame.
export type SocketFactory = (url: string) => WebSocket;

const BACKOFF_BASE_MS = 250;
const BACKOFF_MAX_MS = 5000;
const SOCKET_OPEN = 1;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

type Frame = {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: { message?: unknown } | null;
};

export function wsTransport(
  url: string,
  makeSocket: SocketFactory = (u) => new WebSocket(u),
): NativeTransport {
  let socket: WebSocket | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let nextId = 1;
  let backoffMs = BACKOFF_BASE_MS;
  let eventsSubscribed = false;
  const pending = new Map<number, PendingCall>();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const outbox: string[] = [];

  const dispatch = (event: string, payload: unknown) => {
    for (const cb of listeners.get(event) ?? []) cb(payload);
  };

  const eventsFrame = () => JSON.stringify({ jsonrpc: "2.0", method: "events" });

  // The "events" subscription is per-connection, so it is sent on open (never
  // queued) and re-sent after every reconnect; invoke frames queue instead.
  const subscribeEventsIfOpen = () => {
    if (eventsSubscribed || listeners.size === 0 || !socket || socket.readyState !== SOCKET_OPEN)
      return;
    eventsSubscribed = true;
    socket.send(eventsFrame());
  };

  const handleFrame = (data: string) => {
    let frame: Frame;
    try {
      frame = JSON.parse(data) as Frame;
    } catch {
      return;
    }
    if (frame === null || typeof frame !== "object") return;
    if (frame.method === "events") {
      const params = frame.params as { event?: unknown; payload?: unknown } | undefined;
      if (params && typeof params.event === "string") dispatch(params.event, params.payload);
      return;
    }
    if (typeof frame.id !== "number") return;
    const call = pending.get(frame.id);
    if (!call) return;
    pending.delete(frame.id);
    if (frame.error) {
      const message =
        typeof frame.error.message === "string" ? frame.error.message : "json-rpc error";
      call.reject(new Error(message));
    } else {
      call.resolve(frame.result);
    }
  };

  const connect = () => {
    if (socket || retryTimer !== undefined) return;
    const s = makeSocket(url);
    socket = s;
    s.onopen = () => {
      backoffMs = BACKOFF_BASE_MS;
      // The server's subscription died with the old connection; re-send it
      // before any queued requests flush.
      eventsSubscribed = false;
      subscribeEventsIfOpen();
      for (const frame of outbox.splice(0)) s.send(frame);
    };
    s.onmessage = (ev) => handleFrame(String(ev.data));
    s.onclose = () => {
      socket = undefined;
      for (const call of pending.values()) call.reject(new Error(`ws transport closed: ${url}`));
      pending.clear();
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        connect();
      }, backoffMs);
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    };
  };

  const send = (frame: string) => {
    connect();
    if (socket && socket.readyState === SOCKET_OPEN) socket.send(frame);
    else outbox.push(frame);
  };

  return {
    invoke<T>(command: string, args?: NativeCommandInput): Promise<T> {
      const id = nextId++;
      const frame = JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: command,
        params: args ?? {},
      });
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
        send(frame);
      });
    },
    async listen<T>(event: string, cb: (payload: T) => void): Promise<NativeUnlistenFn> {
      const set = listeners.get(event) ?? new Set<(payload: unknown) => void>();
      listeners.set(event, set);
      const wrapped = cb as (payload: unknown) => void;
      set.add(wrapped);
      connect();
      subscribeEventsIfOpen();
      return () => {
        set.delete(wrapped);
        if (set.size === 0) listeners.delete(event);
      };
    },
  };
}
