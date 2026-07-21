import { Observable, Subject, firstValueFrom, of, take, toArray } from "rxjs";
import { describe, expect, it } from "vitest";
import type { JsonValue } from "./0_types";
import { instanceUrl } from "./1_identity";
import { compileRuntime } from "./2_runtime";
import { accountUsageDocument } from "./3_fixture";

describe("JSON-Rx isolated MVP", () => {
  it("compiles after a JSON serialization round trip", async () => {
    const document = JSON.parse(JSON.stringify(accountUsageDocument)) as typeof accountUsageDocument;
    const runtime = compileRuntime(document, {
      "jsonrx://lab/sources/accounts": () => of({ accountId: "a", interval: 5_000 }),
      "jsonrx://lab/sources/usage/{accountId}": () => of({ percent: 42 }),
    });

    expect(await firstValueFrom(
      runtime.flow("jsonrx://lab/flows/selected-usage").pipe(toArray()),
    )).toMatchInlineSnapshot(`
      [
        {
          "percent": 42,
        },
      ]
    `);
  });

  it("canonicalizes a filled URI-template instance", () => {
    const schema = accountUsageDocument.flows["jsonrx://lab/flows/usage/{accountId}"].parameters;
    const first = instanceUrl(
      "jsonrx://lab/flows/usage/{accountId}",
      schema,
      { path: { accountId: "team a" }, query: { interval: 5_000 } },
    );
    const second = instanceUrl(
      "jsonrx://lab/flows/usage/{accountId}?interval=5000",
      schema,
      { path: { accountId: "team a" } },
    );

    expect({ first, second, same: first === second }).toMatchInlineSnapshot(`
      {
        "first": "jsonrx://lab/flows/usage/team%20a?interval=5000",
        "same": true,
        "second": "jsonrx://lab/flows/usage/team%20a?interval=5000",
      }
    `);
  });

  it("uses one canonical flow instance and one shared source acquisition", async () => {
    let sourceAcquisitions = 0;
    const values$ = new Subject<JsonValue>();
    const runtime = compileRuntime(accountUsageDocument, {
      "jsonrx://lab/sources/accounts": () => of(),
      "jsonrx://lab/sources/usage/{accountId}": (instance) => new Observable((subscriber) => {
        sourceAcquisitions += 1;
        const pathSegments = instance.pathname.split("/");
        const subscription = values$.subscribe((value) => subscriber.next({
          ...value as Record<string, JsonValue>,
          accountId: pathSegments[pathSegments.length - 1] ?? "",
        }));
        return () => subscription.unsubscribe();
      }),
    });
    const parameters = { path: { accountId: "a" }, query: { interval: 5_000 } } as const;
    const first = runtime.flow("jsonrx://lab/flows/usage/{accountId}", parameters);
    const second = runtime.flow("jsonrx://lab/flows/usage/{accountId}", parameters);

    const leftPromise = firstValueFrom(first.pipe(take(1)));
    const rightPromise = firstValueFrom(second.pipe(take(1)));
    values$.next({ percent: 42 });
    const [left, right] = await Promise.all([leftPromise, rightPromise]);

    expect({ sameObservable: first === second, sourceAcquisitions, left, right }).toMatchInlineSnapshot(`
      {
        "left": {
          "accountId": "a",
          "percent": 42,
        },
        "right": {
          "accountId": "a",
          "percent": 42,
        },
        "sameObservable": true,
        "sourceAcquisitions": 1,
      }
    `);
  });

  it("binds outer values into switchMap instance URLs and cancels the prior instance", async () => {
    const accounts$ = new Subject<JsonValue>();
    const usage = new Map<string, Subject<JsonValue>>();
    const runtime = compileRuntime(accountUsageDocument, {
      "jsonrx://lab/sources/accounts": () => accounts$,
      "jsonrx://lab/sources/usage/{accountId}": (instance) => {
        const stream = new Subject<JsonValue>();
        usage.set(instance.toString(), stream);
        return stream;
      },
    });
    const valuesPromise = firstValueFrom(
      runtime.flow("jsonrx://lab/flows/selected-usage").pipe(take(2), toArray()),
    );

    accounts$.next({ accountId: "a", interval: 5_000 });
    usage.get("jsonrx://lab/sources/usage/a?interval=5000")?.next({ accountId: "a", percent: 10 });
    accounts$.next({ accountId: "b", interval: 5_000 });
    usage.get("jsonrx://lab/sources/usage/a?interval=5000")?.next({ accountId: "a", percent: 11 });
    usage.get("jsonrx://lab/sources/usage/b?interval=5000")?.next({ accountId: "b", percent: 20 });

    expect({ values: await valuesPromise, traces: runtime.traces }).toMatchInlineSnapshot(`
      {
        "traces": [
          {
            "instance": "jsonrx://lab/flows/selected-usage",
            "outcome": "flow.subscribe",
            "sequence": 0,
          },
          {
            "instance": "jsonrx://lab/sources/accounts",
            "node": "selected.accounts",
            "outcome": "source.acquire",
            "sequence": 1,
          },
          {
            "instance": "jsonrx://lab/flows/usage/a?interval=5000",
            "outcome": "flow.subscribe",
            "sequence": 2,
          },
          {
            "instance": "jsonrx://lab/sources/usage/a?interval=5000",
            "node": "usage.source",
            "outcome": "source.acquire",
            "sequence": 3,
          },
          {
            "instance": "jsonrx://lab/sources/usage/a?interval=5000",
            "node": "usage.source",
            "outcome": "source.release",
            "sequence": 4,
          },
          {
            "instance": "jsonrx://lab/flows/usage/a?interval=5000",
            "outcome": "flow.unsubscribe",
            "sequence": 5,
          },
          {
            "instance": "jsonrx://lab/flows/usage/b?interval=5000",
            "outcome": "flow.subscribe",
            "sequence": 6,
          },
          {
            "instance": "jsonrx://lab/sources/usage/b?interval=5000",
            "node": "usage.source",
            "outcome": "source.acquire",
            "sequence": 7,
          },
          {
            "instance": "jsonrx://lab/sources/accounts",
            "node": "selected.accounts",
            "outcome": "source.release",
            "sequence": 8,
          },
          {
            "instance": "jsonrx://lab/flows/selected-usage",
            "outcome": "flow.unsubscribe",
            "sequence": 9,
          },
          {
            "instance": "jsonrx://lab/sources/usage/b?interval=5000",
            "node": "usage.source",
            "outcome": "source.release",
            "sequence": 10,
          },
          {
            "instance": "jsonrx://lab/flows/usage/b?interval=5000",
            "outcome": "flow.unsubscribe",
            "sequence": 11,
          },
        ],
        "values": [
          {
            "accountId": "a",
            "percent": 10,
          },
          {
            "accountId": "b",
            "percent": 20,
          },
        ],
      }
    `);
  });

  it("serializes terminal completion and errors as notifications", async () => {
    const completeRuntime = compileRuntime(accountUsageDocument, {
      "jsonrx://lab/sources/accounts": () => of({ accountId: "a", interval: 5_000 }),
      "jsonrx://lab/sources/usage/{accountId}": () => of({ percent: 42 }),
    });
    const errorRuntime = compileRuntime(accountUsageDocument, {
      "jsonrx://lab/sources/accounts": () => of({ accountId: "a", interval: 5_000 }),
      "jsonrx://lab/sources/usage/{accountId}": () => new Observable((subscriber) => {
        subscriber.error(new Error("socket closed"));
      }),
    });

    const complete = await firstValueFrom(
      completeRuntime.materialize("jsonrx://lab/flows/selected-usage").pipe(toArray()),
    );
    const error = await firstValueFrom(
      errorRuntime.materialize("jsonrx://lab/flows/selected-usage").pipe(toArray()),
    );

    expect({ complete, error }).toMatchInlineSnapshot(`
      {
        "complete": [
          {
            "kind": "next",
            "value": {
              "percent": 42,
            },
          },
          {
            "kind": "complete",
          },
        ],
        "error": [
          {
            "error": {
              "code": "Error",
              "message": "socket closed",
            },
            "kind": "error",
          },
        ],
      }
    `);
  });
});
