import type { JsonRxDocument } from "./0_types";

export const accountUsageDocument = {
  jsonRx: "0.1-lab",
  profile: "rxjs-7.8",
  sources: {
    "jsonrx://lab/sources/accounts": {},
    "jsonrx://lab/sources/usage/{accountId}": {
      parameters: {
        path: {
          accountId: { type: "string" },
        },
        query: {
          interval: { type: "integer", default: 60_000 },
        },
      },
    },
  },
  flows: {
    "jsonrx://lab/flows/usage/{accountId}": {
      parameters: {
        path: {
          accountId: { type: "string" },
        },
        query: {
          interval: { type: "integer", default: 60_000 },
        },
      },
      expression: {
        node: "usage.share",
        shareReplay: {
          bufferSize: 1,
          refCount: true,
          input: {
            node: "usage.source",
            source: {
              ref: "jsonrx://lab/sources/usage/{accountId}",
            },
          },
        },
      },
    },
    "jsonrx://lab/flows/selected-usage": {
      expression: {
        node: "selected.switch",
        switchMap: {
          input: {
            node: "selected.accounts",
            source: {
              ref: "jsonrx://lab/sources/accounts",
            },
          },
          ref: "jsonrx://lab/flows/usage/{accountId}",
          path: {
            accountId: { get: "$.accountId" },
          },
          query: {
            interval: { get: "$.interval" },
          },
        },
      },
    },
  },
} satisfies JsonRxDocument;
