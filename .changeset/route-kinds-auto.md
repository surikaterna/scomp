---
"@scompr/core": patch
"@scompr/client": patch
---

Pass route kinds from peer's combinedRouter to ClientFactory automatically, eliminating the need for manual routeHints when using createScompPeer.
