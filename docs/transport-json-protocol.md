# SCOMP Transport JSON Protocol

This protocol is transport-agnostic and is used by RabbitMQ and WebSocket transports.

## Request envelope

```json
{
  "route": "users.getUser",
  "op": "request",
  "payload": {
    "id": 1
  }
}
```

op values:
- request
- signal
- feed_start
- feed_stop

## Response envelope

Success:

```json
{
  "payload": {
    "id": 1,
    "name": "user-1"
  }
}
```

Error:

```json
{
  "error": "Route not found"
}
```

## Feed chunk envelope

Next chunk:

```json
{
  "type": "next",
  "payload": {
    "sequence": 1
  }
}
```

Done:

```json
{
  "type": "done"
}
```

Error:

```json
{
  "type": "error",
  "message": "Feed error"
}
```

## RabbitMQ mapping

- request: queue scomp.rpc.<service>
- signal: topic exchange scomp.signals with route key
- feed fanout: exchange scomp.live.<hash>

## WebSocket mapping

Use the exact same envelopes in websocket text frames.
Only frame transport differs; payload schema is identical.

## Pluggable serialization

Serializer contract:
- stringify(value): string
- parse(text): value
- optional contentType

Default is JSON serializer. Custom replacer/reviver serializers can preserve BigInt and Date.
