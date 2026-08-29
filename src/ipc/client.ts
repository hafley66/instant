// Request/response over a transport. Tauri is one implementation of RpcTransport
// and nothing above this line knows it exists.
export interface RpcTransport {
  request<T>(method: string, params: Record<string, unknown>): Promise<T>;
}

export type Call<Params, Result> = { params: Params; result: Result };
export type Contract = Record<string, Call<Record<string, unknown> | void, unknown>>;

type Camel<S extends string> = S extends `${infer Head}_${infer Tail}`
  ? `${Head}${Capitalize<Camel<Tail>>}`
  : S;

export type Client<C extends Contract> = {
  [K in keyof C & string as Camel<K>]: C[K]["params"] extends void
    ? () => Promise<C[K]["result"]>
    : (params: C[K]["params"]) => Promise<C[K]["result"]>;
};

export const camel = (name: string) => name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

// One typed method per contract entry. Methods are built up front, so an unknown
// name is a type error at the call site and a missing key at runtime.
export function createClient<C extends Contract>(
  methods: readonly (keyof C & string)[],
  transport: RpcTransport,
): Client<C> {
  const client = {} as Record<string, (params?: Record<string, unknown>) => Promise<unknown>>;
  for (const method of methods) {
    client[camel(method)] = (params) => transport.request(method, params ?? {});
  }
  return client as Client<C>;
}
