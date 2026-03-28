# SCOMP JSON Transport Protocol

This document defines the JSON message envelopes used by SCOMP transports.

The same logical schema is used for both RabbitMQ and WebSocket transports.
- RabbitMQ: JSON is carried in AMQP message bodies.
- WebSocket: JSON is carried in text frames.

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
  "type": "next",
  "payload": {
    "sequence": 1
  }
}
```

Completed stream:

```json
{
  "type": "done"
}
```

Stream error:

```json
{
  "type": "error",
  "message": "Feed error"
}
```

## Operation Semantics

### request
- Unary RPC call.
- Client sends request envelope with op=request.
- Server replies with success or error response envelope.

### signal
- Fire-and-forget event.
- Client sends request envelope with op=signal.
- No response expected.

### feed_start
- Starts or joins a feed stream.
- Client sends request envelope with op=feed_start and payload=input.
- Server replies with stream bind metadata in payload (exchange/hash for RabbitMQ).

### feed_stop
- Leaves a feed stream.
- Client sends request envelope with op=feed_stop and payload/hash metadata.

## RabbitMQ Mapping

- request: message to scomp.rpc.<service>, with reply_to + correlation_id.
- signal: publish to exchange scomp.signals with route as routing key.
- feed chunks: publish to fanout exchange scomp.live.<hash>.

## WebSocket Mapping

The WebSocket transport should use the same envelopes:
- Client sends request envelopes as text JSON frames.
- Server sends response envelopes and feed chunk envelopes as text JSON frames.

No schema changes are needed between RabbitMQ and WebSocket transports; only framing and routing differ.

## Pluggable Serialization

SCOMP supports pluggable serializers by interface:

- stringify(value): string
- parse(text): value
- optional contentType

Default serializer is JSON.stringify/JSON.parse with contentType application/json.

Custom serializers can be used to preserve non-JSON-native values such as BigInt and Date.
