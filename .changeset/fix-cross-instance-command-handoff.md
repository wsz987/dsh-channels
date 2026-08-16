---
'@wsz987/channel-harness': patch
'@wsz987/dsh-channels': patch
---

Consume Harness runtimes as peers so npm installs preserve the host Agent scope
when mounting the command-injected child under `agent.ctx`. This prevents `new`
from being registered globally more than once.
