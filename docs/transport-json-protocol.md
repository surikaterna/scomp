# SCOMP JSON Transport Protocol

This document defines the JSON message envelopes used by SCOMP transports.

The same logical schema is used for both RabbitMQ and WebSocket transports.

- RabbitMQ: JSON is carried in AMQP message bodies.
- WebSocket: JSON is carried in text frames.

Browser clients should use `@scompr/transport-websocket-client` with `createBrowserSocketAdapterFactory()`, which follows the same envelope schema as RabbitMQ and Node WebSocket transports.

## Core Envelope Types

### Request Envelope (Client -> Server)

```json
{
  "route": "users.getUser",
  "op": "request",
  "payload": {
    "id": 1
  }
}
```

Fields:

- route: Dot-path route (service.method).
- op: One of request, signal, feed_start, feed_stop.
- payload: Operation input payload.
- meta (optional): Transport metadata for cross-cutting concerns.

Metadata may include invocation and policy hints:

- `traceId`, `tenantId`, `tags`
- `auth` (opaque auth context)
- `priority`, `priorityClass`, `deadlineAtMs`, `targetLatencyMs`

Reserved route namespace:

- `__scomp.*` is reserved for SCOMP control-plane request routes and MUST NOT be used by application routes.

Example metadata:

```json
{
  "meta": {
    "traceId": "trace-123",
    "tenantId": "tenant-a",
    "auth": {
      "token": "opaque-or-jwt-token"
    }
  }
}
```

The `meta.auth` field is intentionally opaque so each deployment can choose credential format
(for example JWT, API key, signed session blob, or mTLS-derived claims).

Priority hints are advisory unless enforced by a transport scheduler or policy layer.

### Response Envelope (Server -> Client)

Success response:

```json
{
  "payload": {
    "id": 1,
    "name": "user-1"
  }
}
```

Error response:

```json
{
  "error": "Route not found: users.getUser"
}
```

### Feed Chunk Envelope (Server -> Client stream)

Next item:

```json
{
  "id": "req-1",
  "type": "next",
  "channel": "feed",
  "hash": "7d8f67a9d3a4e9f0c1b2d3e4f5a6b7c8",
  "payload": {
    "sequence": 1
  }
}
```

Completed stream:

```json
{
  "id": "req-1",
  "type": "done",
  "channel": "feed",
  "hash": "7d8f67a9d3a4e9f0c1b2d3e4f5a6b7c8"
}
```

Stream error:

```json
{
  "id": "req-1",
  "type": "error",
  "channel": "feed",
  "hash": "7d8f67a9d3a4e9f0c1b2d3e4f5a6b7c8",
  "message": "Feed error"
}
```

## Operation Semantics

### request

- Unary RPC call.
- Client sends request envelope with op=request.
- Server replies with success or error response envelope.
- Transport MAY attach response metadata in `meta`.

### signal

- Fire-and-forget event.
- Client sends request envelope with op=signal.
- No response expected.

### feed_start

- Starts or joins a feed stream.
- Client sends request envelope with op=feed_start and payload=input.
- Server replies with stream bind metadata in payload (exchange/hash for RabbitMQ).
- Feed chunks include `channel` and `hash` fields for stream demultiplexing.

### feed_stop

- Leaves a feed stream.
- Client sends request envelope with op=feed_stop and payload/hash metadata.
- Browser transport parity guarantee: `feed_stop` uses the same invocation metadata shape as `feed_start` for the originating call context.

## Control-Plane Routes (`__scomp.*`)

Control-plane operations are implemented as ordinary `op: request` routes and therefore reuse the same envelope contract.

### `__scomp.discover`

Purpose:

- Return node-local service inventory and route capabilities.

Request payload:

```json
{
  "servicePrefix": "users",
  "includeRoutes": true
}
```

Response payload:

```json
{
  "services": [
    {
      "name": "users",
      "routes": ["users.getUser", "users.list"]
    }
  ],
  "node": {
    "id": "node-a"
  },
  "generatedAt": "2026-03-28T15:00:00.000Z",
  "ttlMs": 1500
}
```

### `__scomp.resolve`

Purpose:

- Resolve a target application route and return endpoint/channel selection data.

Request payload:

```json
{
  "route": "users.getUser",
  "channel": "ws:alternate"
}
```

Response payload (current-channel fallback example):

```json
{
  "resolved": true,
  "fallbackUsed": true,
  "endpoint": {
    "route": "users.getUser",
    "channel": "current-channel",
    "transport": "websocket"
  },
  "candidates": [
    {
      "route": "users.getUser",
      "channel": "ws:alternate",
      "transport": "websocket"
    },
    {
      "route": "users.getUser",
      "channel": "current-channel",
      "transport": "websocket"
    }
  ]
}
```

### `__scomp.health`

Purpose:

- Return node-local health status with shallow/deep modes.

Request payload:

```json
{
  "mode": "deep",
  "verbose": true,
  "service": "users"
}
```

Response payload:

```json
{
  "status": "ok",
  "checks": [
    {
      "name": "users.db",
      "status": "ok"
    }
  ],
  "node": {
    "id": "node-health"
  },
  "timestamp": "2026-03-28T16:00:00.000Z"
}
```

### Security posture

- Treat all `__scomp.*` routes as privileged and internal-only by default.
- Require explicit authorization policy per control-plane route before external exposure.
- Keep discover/resolve responses minimal and avoid leaking internal topology details unless explicitly needed.
- Keep non-verbose health responses lightweight; expose detailed checks only to authorized callers.

### Compatibility notes

- No transport protocol operation changes are required for control-plane support.
- Existing clients can call control-plane routes using standard request envelopes.
- Clients that do not call `__scomp.*` routes are unaffected.

## RabbitMQ Mapping

- request: message to scomp.rpc.<service>, with reply_to + correlation_id.
- signal: publish to exchange scomp.signals with route as routing key.
- feed chunks: publish to fanout exchange scomp.live.<hash>.

## WebSocket Mapping

The WebSocket transport should use the same envelopes:

- Client sends request envelopes as text JSON frames.
- Server sends response envelopes and feed chunk envelopes as text JSON frames.

No schema changes are needed between RabbitMQ and WebSocket transports; only framing and routing differ.

### Browser WebSocket mapping

- Browser/runtime clients use `@scompr/transport-websocket-client` with `createBrowserSocketAdapterFactory()`.
- `request`, `signal`, `feed_start`, and `feed_stop` propagate invocation metadata and priority hints in `meta`.
- Auth middleware (via `createAuthMiddleware`) can intercept outbound calls before frames are sent.

## Pluggable Serialization

SCOMP supports pluggable serializers by interface:

- stringify(value): string
- parse(text): value
- optional contentType

Default serializer is JSON.stringify/JSON.parse with contentType application/json.

Custom serializers can be used to preserve non-JSON-native values such as BigInt and Date.

## Cross-Transport Authentication and Authorization

SCOMP security is transport-agnostic and enforced via the middleware system at the peer level:

- Inbound: middleware intercepts incoming requests before handlers execute.
- Outbound: middleware can inject auth metadata or block unauthorized calls.
- The `createAuthMiddleware` helper provides standard authenticate/authorize hooks.

Recommended middleware configuration:

1. `authenticate(context)` — resolve identity from context (route, operation, payload, meta).
2. `authorize({ ...context, principal })` — decide if the resolved principal may proceed.

If no middleware is configured, peers default to allow-all behavior for backward compatibility.

### Security caveats

- Browser-side middleware is a client policy layer, not a server trust boundary.
- Always enforce final authentication/authorization on the receiving server peer.
