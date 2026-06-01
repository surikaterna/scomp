---
"@scompr/types": minor
"@scompr/core": minor
"@scompr/client": minor
"@scompr/transport-shared": minor
"@scompr/transport-rabbitmq": minor
"@scompr/transport-browser-windows": minor
"@scompr/transport-inprocess": minor
"@scompr/transport-websocket-client": minor
"@scompr/transport-websocket-server-runtime": minor
"@scompr/transport-websocket-server": minor
"@scompr/transport-websocket-shared": minor
---

Initial public release of the sComPR service composition framework.

- Dual ESM/CJS packaging with full TypeScript declarations
- Strict TypeScript throughout (no `any` escape hatches)
- Transport-agnostic core with pluggable transport layer
- Request/signal/feed messaging patterns
- Middleware support for auth, logging, and custom concerns
- Available transports: in-process, RabbitMQ, WebSocket (client + server), browser windows
