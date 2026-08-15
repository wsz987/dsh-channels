# Optional Generic File Extension Implementation Plan

1. Add the minimal `ChannelFileProvider` port to `channel-harness` and make its
   lifecycle resolve the service optionally.
2. Move private storage, extraction, and `read_channel_attachment` into the new
   `@wsz987/channel-files` package.
3. Replace the handwritten PDF parser with `unpdf`; move `mammoth` and `xlsx`
   dependencies out of `channel-harness`.
4. Delegate outbound attachment lookup to the provider while retaining
   provider-independent proactive text sending in `channel-harness`.
5. Activate the extension as a removable bundle line and document the switch.
6. Verify provider-present/provider-absent behavior, PDF extraction, package
   boundaries, type checking, and the full test suite.

