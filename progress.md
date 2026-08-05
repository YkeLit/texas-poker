Original prompt: Implement the extensible shared room/reconnect runtime and migrate Texas Hold'em to dedicated Redis, secure reconnect, multi-connection presence and continue/auto-action behavior.

## 2026-08-05

- Vendored the exact shared runtime release-candidate and registered the `continueWhileMissing` Texas Hold'em policy.
- Removed production Redis-to-memory fallback; startup and `/readyz` now fail closed when the dedicated room Redis is unavailable.
- Switched Compose from its private Redis container to navigation's `games-room-redis` through a Docker Secret.
- Added expiry to signed Socket.IO join tokens.
- Existing engine behavior already continues timers, auto check/fold, tracks multiple socket connections and sits a player out after two missed hands.

TODO: replace plaintext resume-token request bodies/localStorage with the shared `__Host-texas-poker_guest` cookie and move active room snapshots from the transitional cache keys to `room:v1:texas-poker:`.

Verification: server TypeScript check, 21 server tests, server build, shared package integrity pin, Compose rendering and `git diff --check` pass.
