---
"@scompr/core": minor
"@scompr/client": minor
"@scompr/transport-inprocess": minor
---

Add unified `invoke()` transport method and `ScompResult` dual-protocol return type. The client proxy now automatically dispatches all calls through `invoke()` when available, eliminating the need for `routeHints`. The server response determines whether the result is a value (request), void (signal), or stream (feed). Consumer code uses natural patterns: `await` for requests/signals, `for await...of` for feeds.
