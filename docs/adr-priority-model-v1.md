# ADR: SCOMP Priority Classes and Default Operation Mapping (v1)

- Issue: `scomp-spr.1`
- Status: Accepted
- Date: 2026-03-28

## Context

SCOMP v1 runs over multiple transports with a shared request envelope model (`request`, `signal`, `feed_start`, `feed_stop`).

We need deterministic priority semantics that are transport-agnostic and backward compatible, while explicitly deferring transport-level schedulers/queues to later work.

## Decision

### Priority classes (P0-P4)

Priority in v1 is a policy-level hint that resolves to an effective class. Lower number means higher urgency.

| Class | Name | Intent | Typical examples |
| --- | --- | --- | --- |
| P0 | Critical control/safety | Protect system safety and availability | shutdown/stop, circuit-breaker open, hard resource protection |
| P1 | Interactive control | User-visible control-plane and fast path coordination | health checks, discovery/resolve, session/auth refresh |
| P2 | Default request | Normal business RPC traffic | most request/response operations |
| P3 | Bulk/async | Throughput-oriented and non-interactive work | telemetry fan-out, batch processing signals |
| P4 | Background/deferred | Lowest urgency, deferrable work | backfills, prefetch, low-value periodic tasks |

### Effective priority resolution

Effective class is resolved in this order:

1. Explicit route policy override
2. Metadata hint (if present and allowed by policy)
3. Operation default
4. Fallback to `P2`

Rules:

- Unknown or invalid priority values are treated as `P2`.
- Policies may clamp metadata hints to a configured max/min range.
- Missing metadata must be safe and deterministic (no transport-specific behavior).

## Default mapping by operation and use-case

Base defaults:

| Operation | Default class | Rationale |
| --- | --- | --- |
| `request` | P2 | Primary RPC path; balanced default |
| `signal` | P3 | Fire-and-forget events are generally less latency-sensitive |
| `feed_start` | P1 | Stream start is usually user-visible and latency-sensitive |
| `feed_stop` | P0 | Fast teardown prevents resource leaks and fan-out waste |

Recommended route/use-case overrides:

- Control-plane and availability routes (`health`, discovery, endpoint resolution): `P1`
- Safety and protection controls (shed trigger, emergency stop, hard circuit control): `P0`
- User-blocking interactive reads/writes: `P1`
- Standard API/business RPC: `P2`
- Non-critical event emission and analytics signals: `P3`
- Backfills, cache warmups, and maintenance jobs: `P4`

## Fairness and starvation prevention principles

v1 does not introduce a transport queue scheduler. Starvation prevention is therefore defined as policy guidance and minimum fairness guarantees:

- **Work-conserving preference**: always prefer higher priority when contention exists.
- **Class floor for progress**: reserve a small execution floor for lower classes so they can still complete under sustained load.
- **Aging guidance**: long-waiting P3/P4 work should be eligible for temporary promotion by policy if wait time exceeds configured thresholds.
- **Per-route budgets**: cap concurrency and in-flight depth per route/use-case to prevent one route from monopolizing capacity.
- **Deterministic tie-breaks**: within a class, process FIFO by arrival timestamp to avoid reordering surprises.

These rules are normative for policy behavior and observability in v1; concrete scheduler mechanics are deferred.

## Load-shedding recommendations

When the node is saturated, shed from the lowest class first:

1. Reject/defer `P4` first
2. Then shed `P3`
3. Apply bounded queueing/timeouts to `P2`
4. Preserve `P1` whenever possible
5. Preserve `P0` except when required for process survival

Operational guidance:

- Return explicit overload errors (for example, a busy/retryable failure) for shed traffic.
- Emit telemetry for `requested_priority`, `effective_priority`, and `shed_reason`.
- Track queue wait and admission latency by effective class.

## Compatibility guarantees

- Priority remains metadata/policy-level in v1; no new mandatory transport envelope fields are required.
- Nodes that do not understand priority hints still interoperate via default behavior (`P2`).
- Behavior is deterministic even when metadata is absent or partially populated.

## Explicit non-goals (v1)

- No broker/transport-specific scheduler implementation (for example, RabbitMQ priority queues).
- No global cross-node fairness guarantees.
- No strict real-time latency/SLO guarantees by class.
- No automatic semantic inference of priority from payload contents.

## Consequences

- Teams can adopt priority semantics now using policy and metadata without changing transport contracts.
- Later scheduler work can implement stronger guarantees while reusing these class definitions and defaults.
