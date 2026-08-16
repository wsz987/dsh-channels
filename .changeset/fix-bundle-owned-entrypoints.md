---
'@wsz987/dsh-channels': patch
---

Expose every Harness loader entry and the Web client from the bundle package so
a profile only needs `@wsz987/dsh-channels` as a direct dependency. This fixes
registry installs under pnpm's isolated dependency layout.
