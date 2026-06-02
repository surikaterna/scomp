# @scompr/transport-websocket-server

## 0.2.0

### Patch Changes

- d59ca8b: Add `v: 1` protocol version field to all wire envelope types for forward compatibility
- 4b57524: **BREAKING:** `ITransport` interface now requires only `invoke()`. The `request()`, `signal()`, and `feed()` methods have been removed. All transports dispatch through a single `invoke()` method that determines behavior from the route's registered kind. `ClientRouteHints` are deprecated and no longer needed — the transport handles dispatch automatically.
- Updated dependencies [4b57524]
  - @scompr/core@0.1.1
  - @scompr/transport-shared@0.1.1

## 0.1.0

### Minor Changes

- 0e69351: Initial public release of the sComPR service composition framework.
  - Dual ESM/CJS packaging with full TypeScript declarations
  - Strict TypeScript throughout (no `any` escape hatches)
  - Transport-agnostic core with pluggable transport layer
  - Request/signal/feed messaging patterns
  - Middleware support for auth, logging, and custom concerns
  - Available transports: in-process, RabbitMQ, WebSocket (client + server), browser windows

### Patch Changes

- Updated dependencies [0e69351]
  - @scompr/core@1.0.0
  - @scompr/transport-shared@1.0.0
