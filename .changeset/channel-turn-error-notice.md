---
'@wsz987/channel-harness': patch
'@wsz987/dsh-channels': patch
---

Channel-triggered Harness turns that terminate with
`turn/end.reason.kind = "error"` now return a safe terminal failure notice to
the originating channel. `AUTH` failures hide raw provider diagnostics and
display `API key is invalid`. No-output terminal turns also stop typing
indicators correctly. Structured `QUOTA` diagnostics prefer their validated
provider message over the raw status and JSON envelope.
