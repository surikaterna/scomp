---
"@scomp/types": minor
"@scomp/core": minor
"@scomp/client": minor
"@scomp/transport-shared": minor
"@scomp/transport-rabbitmq": minor
"@scomp/transport-browser-windows": minor
"@scomp/transport-inprocess": minor
"@scomp/transport-websocket-client": minor
"@scomp/transport-websocket-server-runtime": minor
"@scomp/transport-websocket-server": minor
"@scomp/transport-websocket-shared": minor
---

Initial public release of the scomp service composition framework.

- Dual ESM/CJS packaging with full TypeScript declarations
- Strict TypeScript throughout (no `any` escape hatches)
- Transport-agnostic core with pluggable transport layer
- Request/signal/feed messaging patterns
- Middleware support for auth, logging, and custom concerns
- Available transports: in-process, RabbitMQ, WebSocket (client + server), browser windows
