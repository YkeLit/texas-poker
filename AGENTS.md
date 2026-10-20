# Texas Poker agent guide

## Startup and team

Read `README.md`, `progress.md`, `package.json`, and relevant workspace code/tests. Then read [the independent boardgame-dev-team skill](/Users/yangke/.codex/skills/boardgame-dev-team/SKILL.md) and the assigned role under its `references/roles/` directory. Delegate with the skill `references/task-template.md` and explicit writable paths.

The original rules-research agent must browse relevant tabletop forum discussions, turn verified community caveats into cases, and later operate the real game UI as a player to validate a complete game and applicable cases. Keep its agent identity and evidence across stages; its playthrough does not replace API acceptance or the device matrix.

## Project boundaries

Follow the shared [staged validation requirements](/Users/yangke/.codex/skills/boardgame-dev-team/references/validation.md): confirm rules → backend logic, real API tests and at least two independent non-implementer agents' acceptance → UI with at least two visual/interaction rounds across desktop/mobile, landscape/portrait, small windows and dynamic resizing → new reconnect/recovery and other supplementary features. Do not start the next stage before the applicable checks pass; record evidence in `progress.md`. Preserve existing runtime contracts and keep basic identity, permissions and hidden-information protection in the backend stage.

- Rules: `packages/poker-engine/`; public contracts: `packages/shared/`; service: `apps/server/`; UI: `apps/web/`.
- The service owns dealing, actions, side pots and settlement. Keep the engine independent of transport and storage.
- Viewer projections expose only allowed hole cards; do not send opponents' hidden hands, deck order or RNG seed to clients or logs.
- Preserve shared room runtime CAS, request replay, secure guest identity and multi-tab presence. Persist action deadlines and rebuild timers after restart; existing missing-player policy continues with automatic check/fold.
- Production room state uses dedicated Redis and fails readiness on Redis errors. Do not add process-memory fallback or SQL archives.
- Coordinate shared contract and dependency ownership; preserve existing changes.

## Verification and handoff

- Code changes: `corepack pnpm test` and `corepack pnpm build`. The root currently has no `typecheck` script; do not claim to have run one.
- Read `apps/server/tests/integration-smoke.mjs` and `restart-smoke.mjs` before relevant Redis/HTTP/Socket recovery verification; obtain actual multi-player and browser evidence for online/UI changes.
- Configuration changes: `docker compose config`. Documentation-only changes: validate links/paths and `git diff --check`.
- Record actual checks and next steps in `progress.md`. Use existing `render_game_to_text` / time-control hooks when applicable.
