---
'@wsz987/channel-harness': patch
'@wsz987/dsh-channels': patch
---

Make Agent-scoped channel command registration safe across overlapping Bridge
reloads by serializing ownership handoff and ignoring stale disposers.
