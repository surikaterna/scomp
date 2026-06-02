---
"@scompr/core": major
"@scompr/client": major
"@scompr/transport-inprocess": major
"@scompr/transport-websocket-client": major
"@scompr/transport-websocket-server": major
"@scompr/transport-browser-windows": major
"@scompr/transport-rabbitmq": major
"@scompr/types": minor
---

**BREAKING:** `ITransport` interface now requires only `invoke()`. The `request()`, `signal()`, and `feed()` methods have been removed. All transports dispatch through a single `invoke()` method that determines behavior from the route's registered kind. `ClientRouteHints` are deprecated and no longer needed — the transport handles dispatch automatically.
