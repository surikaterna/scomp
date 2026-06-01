# @scompr/core

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
  - @scompr/types@0.1.0
