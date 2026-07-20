# Keyed aggregation and Jenkins job tracking

An automation that watches Jenkins needs to normalize observations, assign a
stable key, reduce each key independently, and persist the latest state as a
materialized row.

## Event topology

```text
navigation, page network response, or timer
  -> observe Jenkins response
  -> JSONata normalization
  -> one jenkins.job.observed event per job
  -> partition by stable job key
  -> reduce previous and next job state
  -> emit change events
  -> upsert materialized job row
  -> TreeTable renders current rows
```

## Normalized observation

```json
{
  "type": "jenkins.job.observed",
  "partitionKey": "folder-a/build-app",
  "time": 1784580000000,
  "data": {
    "name": "build-app",
    "folder": "folder-a",
    "status": "SUCCESS",
    "build": 418,
    "durationMs": 84321,
    "url": "https://jenkins.example.com/job/folder-a/job/build-app/418/"
  }
}
```

`partitionKey` identifies the state-machine instance. One job has one state
timeline regardless of which page, tab, or polling source observed it.

## Job state

```ts
type JenkinsJobState = {
  value: "unknown" | "known";
  id: string;
  name: string;
  status: string;
  previousStatus?: string;
  build?: number;
  durationMs?: number;
  changedAt?: number;
  observedAt: number;
  url: string;
};
```

For each observation, the transition reads one previous state and emits one
next state. A status change can also emit `jenkins.job.changed`.

```ts
type JenkinsJobTransition = (
  state: JenkinsJobState,
  event: JenkinsJobObserved,
) => Transition;
```

```text
read previous job state
  -> copy previous status
  -> write observed status, build, duration, URL, and observed time
  -> if status differs, write changed time
  -> if status differs, emit jenkins.job.changed
```

## Materialized storage

The persistent representation is one row per stream and key:

```ts
type MaterializedRow = {
  stream: string;
  key: string;
  value: State;
  revision: number;
  updatedAt: number;
};
```

Uniqueness condition:

```text
(stream, key) unique
```

Write sequence:

```text
jenkins.job.observed
  -> partitioned machine emission
  -> storage.upsert {
       stream: "jenkins.jobs",
       key: partitionKey,
       value: state
     }
```

Read sequence:

```text
Jenkins panel mount
  -> query stream "jenkins.jobs"
  -> current row per job key
  -> TreeTable rows
  -> later upserts replace matching row keys
```

The event history and materialized rows have separate cardinalities. Event
history can retain every observation or every change. The materialized stream
retains one current row per key.

## Change detection

Three serializable policies cover field-level, predicate, and normalized-object
comparison.

```ts
type ChangeDetection =
  | { by: "field"; paths: string[] }
  | { by: "json-logic"; expression: unknown }
  | { by: "hash"; expression?: JsonataExpression };
```

Field comparison:

```json
{
  "by": "field",
  "paths": ["status", "build"]
}
```

Predicate comparison:

```json
{
  "by": "json-logic",
  "expression": {
    "!=": [
      { "var": "previous.status" },
      { "var": "next.status" }
    ]
  }
}
```

Normalized hashing:

```json
{
  "by": "hash",
  "expression": "{ 'status': color, 'build': lastBuild.number }"
}
```

JSONata removes timestamps and response noise before hashing. The hash changes
only when the selected structure changes.

## Observation routes

Jenkins data can enter through:

1. `netcapture` when a Jenkins page performs its own API request.
2. A scheduled reload of an existing inactive Jenkins tab.
3. The legacy dedicated background-tab scan.
4. A future `http.request` effect using browser or backend credentials.

The proposed HTTP effect envelope is:

```json
{
  "op": "http.request",
  "input": {
    "url": "https://jenkins.example.com/api/json?tree=jobs[name,color,url,lastBuild[number,timestamp,duration]]",
    "credentials": "browser",
    "response": {
      "event": "jenkins.response"
    }
  }
}
```

`http.request` is not currently implemented. A browser interpreter would use
Chrome host permissions and browser credentials. A backend interpreter would
require separately configured Jenkins credentials.

## Minimal generic additions

```ts
function upsertMaterializedState(
  stream: string,
  key: string,
  state: State,
): Promise<void>;
```

Jenkins-specific configuration then consists of a JSONata projection, JSON
Schema, routine reference, stable partition-key expression, and TreeTable
column definitions.
