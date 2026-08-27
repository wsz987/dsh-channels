---
'@wsz987/channel-harness': patch
---

Restrict every group-chat slash command to the access policy owner. Missing or
mismatched owner identity now denies the command before `/stop`, session,
binding, workspace, or Agent side effects while leaving ordinary group messages
under the existing access policy.
