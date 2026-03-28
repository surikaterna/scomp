# ADR: SCOMP Control-Plane Reserved Namespace and Route Contracts (v1)

- Issue: `scomp-b6r.1`
- Status: Accepted
- Date: 2026-03-28

## Context

SCOMP needs a node-local control plane for service discovery, endpoint resolution, and health checks that works across existing transports.

v1 must stay wire-compatible with the current JSON request envelope model and operation set (`request`, `signal`, `feed_start`, `feed_stop`).

## Decision

### Reserved namespace

SCOMP reserves the route namespace prefix `__scomp` for framework-owned control-plane routes.

Rationale for `__scomp` (instead of `$scomp`):

- Double-underscore is a clear, conventional marker for reserved/internal framework namespaces.
- Underscore + alphanumeric route tokens are broadly portable across brokers, routing-key conventions, and tooling.
- `$` carries special meaning in regular expressions and some ecosystem conventions, increasing escaping and integration risk.
- Keeping the canonical reserved namespace ASCII-simple reduces ambiguity in logs, policy matchers, and route filtering.

Reservation rules:

- User/application routes MUST NOT use `__scomp` or `__scomp.*`.
- Registration or composition collisions with reserved control routes MUST fail deterministically with a clear error.
- v1 control routes are request routes only; no new protocol operation is introduced.

### Route names and operation

The following route names are normative in v1:

- `__scomp.discover`
- `__scomp.resolve`
- `__scomp.health`

All three routes use `op: request` and the existing request/response envelopes.

### Contract boundaries (v1)

Control-plane contracts are payload-level contracts inside standard SCOMP envelopes.

Shared boundaries:

- Request payload MUST be a JSON object.
- Success responses return `{ "payload": { ... } }`.
- Failures return `{ "error": "..." }` using existing error envelope behavior.
- Unknown request fields SHOULD be ignored unless explicitly marked invalid by route policy.
- Additional response fields MAY be added in minor versions; existing required fields are stable.

#### `__scomp.discover`

Purpose: list node-local, currently available service/route capabilities.

Request payload (all optional):

- `servicePrefix: string` - filters discovered services by prefix.
- `includeRoutes: boolean` - includes per-service route lists when `true`.

Response payload:

- `services: Array<{ name: string; routes?: string[] }>`
- `node: { id: string }`

#### `__scomp.resolve`

Purpose: resolve a callable endpoint for a target route with current-channel fallback semantics.

Request payload:

- `route: string` (required) - target application route to resolve.
- `channel: string` (optional) - caller's current channel hint.

Response payload:

- `resolved: boolean`
- `endpoint?: { route: string; channel: string; transport?: string }`
- `fallbackUsed: boolean` - `true` when current-channel fallback is selected.

Fallback rule:

- Resolver first attempts a policy-preferred endpoint.
- If unavailable and `channel` is present, resolver may return a current-channel endpoint for the route.
- If no acceptable endpoint exists, `resolved` is `false`.

#### `__scomp.health`

Purpose: report node-local health status for control and operational checks.

Request payload (all optional):

- `verbose: boolean` - includes check-level details when `true`.

Response payload:

- `status: "ok" | "degraded" | "down"`
- `checks?: Array<{ name: string; status: "ok" | "degraded" | "down"; message?: string }>`
- `node: { id: string }`

## Compatibility guarantees

- No new transport protocol operation is introduced in v1.
- Existing envelope fields remain valid; control-plane semantics live under `route` + `payload`.
- Clients that do not call `__scomp.*` routes are unaffected.
- Older clients can call these routes using standard request envelopes without transport upgrades.

## Security and exposure posture (v1)

- Control-plane routes are ordinary routes and therefore use existing authentication/authorization hooks.
- Implementations SHOULD treat `__scomp.*` as privileged and apply explicit policy for external exposure.
- Discovery and health responses SHOULD avoid leaking sensitive runtime details by default.

## Explicit non-goals (v1)

- No out-of-band transport control protocol.
- No cross-node/global service registry semantics.
- No transport-specific schema forks for control-plane routes.

## Consequences

- Control-plane behavior is transport-agnostic and immediately usable with existing request handling.
- Downstream work (`types`, `core composition`, `handlers`, `docs`, `guardrails`) can implement against stable route names and payload boundaries.
