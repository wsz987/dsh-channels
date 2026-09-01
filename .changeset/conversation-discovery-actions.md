---
'@wsz987/channel-core': patch
'@wsz987/channel-control': patch
'@wsz987/channel-web': patch
'@wsz987/channel-qq': patch
'@wsz987/channel-dingtalk': patch
'@wsz987/channel-lark': patch
'@wsz987/dsh-channels': patch
---

Add canonical conversation discovery for access-policy configuration, including
QQ group OpenID discovery and an explicit Web refresh control. Normalize QQ and
DingTalk activation facts used by the shared access layer, and update Lark
interactive question actions to the official Card 2.0 callback-button schema.
