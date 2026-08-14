---
'@dsh/channel-harness': minor
---

ReplyContext becomes the required outbound gate. A turn is only delivered back
to a channel when it has an active `ReplyContext` (`register` →
`agent/inbox/claimed` → `getTurn`) — a turn driven by another surface (Web UI /
CLI / steer / scheduler) on a channel-bound session is no longer auto-routed to
the channel. `SessionBinding` (where a reply would go) and `ReplyContext`
(whether it should go back) are now strictly separated. `turn/start` no longer
establishes an active reply, and the durable-log reconcile path applies the
same gate.
