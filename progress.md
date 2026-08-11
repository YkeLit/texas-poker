Original prompt: Implement the extensible shared room/reconnect runtime and migrate Texas Hold'em to dedicated Redis, secure reconnect, multi-connection presence and continue/auto-action behavior.

## 2026-08-10

- Completed the `@ykelit/games-room-runtime` 1.1.1 cutover using `room:v1:texas-poker:` and the shared six-character room, nickname uniqueness, revision, replay and expiry behavior.
- Replaced localStorage/session/resume-token and signed websocket join flows with the 30-day `__Host-texas-poker_guest` HttpOnly Secure SameSite=Lax cookie. The browser stores only the most recent room code.
- Implemented the common HTTP endpoints and `room.attach`, `command`, `command.result`, `state.snapshot`, `presence.changed` and `room.expired` Socket.IO protocol with exact Origin validation.
- All player and server timer actions use the same requestId idempotency and Redis CAS revision path. Deals are deterministic from the accepted request ID, so retries cannot reshuffle.
- Texas Hold'em continues while players are missing, auto checks/folds at the persisted action deadline, and marks disconnected ready players sit-out after two missed hands. Multiple tabs share one seat and only the final disconnect changes presence.
- Added runtime timer restoration: attaching after a full server restart restores the same room/private hand and rebuilds the remaining action timer from Redis.
- Viewer snapshots expose only the viewer's hole cards; opponents expose only card counts. Deck order and random seed are never sent.
- Removed the old process-memory RoomService, plaintext resume-token cache, websocket token signer and their HTTP/Socket routes.
- Removed SQL and all archive writes; active rooms, chat and hand state are intentionally ephemeral Redis state for this personal-use deployment.

Verification:

- 34 unit/component/adapter tests pass across shared, engine, server and web packages; production builds pass for all four packages.
- Real Redis HTTP/Socket smoke passed create/join, secure cookie flags, two private views, chat, multi-tab final-disconnect presence and automatic check/fold.
- Full server restart restored room `JPXW2L`, the same two private cards and the persisted timer; the timer advanced revision after restart.
- The required web-game Playwright client produced `/tmp/texas-poker-game-test/shot-0.png` and a lobby `render_game_to_text` snapshot with no console-error file; visual inspection passed.
- Redis-backed restart recovery, Compose rendering and `git diff --check` pass.
- Runtime 1.1.1 integrity is pinned to `sha512-iCt9bX...EHSg==`; all 34 tests and production builds pass after the patch upgrade.
