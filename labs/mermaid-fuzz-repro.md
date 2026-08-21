# Mermaid fuzz repro

Two render paths to check. Say which one is fuzzy.

| path | how to reach it | what to look at |
| --- | --- | --- |
| inline overlay | `cat labs/mermaid-fuzz-repro.md` in a terminal tab | the diagram drawn over the terminal rows |
| lightbox | click that overlay to expand | the full-screen viewer, zoom with cmd+wheel |
| mdview | open this file in a preview tab | the rendered markdown panel |

## 1. Large flowchart, 24 nodes

```mermaid
flowchart LR
  A[Ingest Source] --> B[Normalise Records]
  B --> C{Schema Valid}
  C -->|yes| D[Enrich Metadata]
  C -->|no| E[Quarantine Queue]
  D --> F[Deduplicate By Key]
  F --> G[Partition By Tenant]
  G --> H[Write Primary Store]
  G --> I[Write Search Index]
  H --> J{Replication Lag}
  J -->|under threshold| K[Publish Change Event]
  J -->|over threshold| L[Backpressure Signal]
  L --> M[Throttle Ingest]
  M --> A
  K --> N[Downstream Consumers]
  N --> O[Billing Aggregator]
  N --> P[Usage Reporter]
  N --> Q[Anomaly Detector]
  Q --> R{Anomaly Score}
  R -->|high| S[Page On Call]
  R -->|low| T[Append Audit Log]
  E --> U[Manual Review Console]
  U --> V{Operator Decision}
  V -->|repair| B
  V -->|discard| W[Cold Archive]
```

## 2. Wide sequence diagram

```mermaid
sequenceDiagram
  participant U as User Agent
  participant G as API Gateway
  participant A as Auth Service
  participant O as Order Service
  participant P as Payment Provider
  participant L as Ledger
  U->>G: POST /orders with idempotency key
  G->>A: validate bearer token
  A-->>G: subject claims and scopes
  G->>O: create order draft
  O->>L: reserve funds hold
  L-->>O: hold identifier
  O->>P: authorise charge
  P-->>O: authorisation code
  O->>L: commit hold to charge
  L-->>O: ledger entry identifier
  O-->>G: order confirmed
  G-->>U: 201 Created with order body
```

## 3. State machine

```mermaid
stateDiagram-v2
  [*] --> Draft
  Draft --> Submitted: operator submits
  Submitted --> Validating: queue picks up
  Validating --> Rejected: schema failure
  Validating --> Approved: all checks pass
  Approved --> Provisioning: capacity granted
  Provisioning --> Running: first heartbeat
  Running --> Degraded: error rate over budget
  Degraded --> Running: recovery observed
  Degraded --> Terminated: budget exhausted
  Running --> Terminated: operator stop
  Rejected --> Draft: operator edits
  Terminated --> [*]
```

## 4. Class diagram with long member names

```mermaid
classDiagram
  class RenderAdapter {
    +String implementationName
    +Geometry currentGeometry
    +initialiseBackend() Promise
    +applyCameraTransform() void
    +updateNodePositions(count) void
  }
  class PixiProjection {
    +ParticleContainer batchedNodes
    +generateNodeTexture() Texture
  }
  class ThreeProjection {
    +InstancedMesh batchedNodes
    +CSS2DRenderer labelLayer
  }
  RenderAdapter <|-- PixiProjection
  RenderAdapter <|-- ThreeProjection
```
