# Migration: browser transport parity

This guide captures behavior that is now aligned across transports when using `@scomp/transport-websocket-client`.

## Who should migrate

Use this guidance if your browser client already uses SCOMP WebSocket transport and you want predictable parity with Node WebSocket and RabbitMQ transports.

## What is now consistent

- Invocation options are carried on `request`, `signal`, `feed_start`, and `feed_stop` envelopes.
- Priority-related hints (`priority`, `priorityClass`, `deadlineAtMs`, `targetLatencyMs`) are serialized into `meta`.
- Metadata precedence is deterministic:
  1. transport `config.meta`
  2. per-call `meta`
  3. per-call priority hints
  4. principal-derived metadata from security hooks

## Recommended migration steps

1. Ensure browser clients depend on `@scomp/transport-websocket-client` and use `createBrowserSocketAdapterFactory()`.
2. Update client call sites to pass invocation options where needed.
3. If using browser-side security hooks, treat them as client policy checks only.
4. Keep authoritative authN/authZ checks on the server transport.

## Caveats

- Browser-side auth middleware can improve consistency but does not create a trust boundary.
- `meta.auth` is intentionally opaque and must be validated server-side.
- Priority hints are advisory metadata unless your transport/policy layer enforces scheduling.
