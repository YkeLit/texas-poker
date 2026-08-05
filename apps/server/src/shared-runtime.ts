import { continueWhileMissing } from "@ykelit/games-room-runtime";

export const texasPokerRoomRuntimeRegistration = {
  gameId: "texas-poker",
  protocolVersion: 1,
  redisKeyPrefix: "room:v1:texas-poker:",
  disconnectPolicy: continueWhileMissing({ reconnectWindowMs: 2 * 60 * 60_000 }),
  capabilities: ["multi-connection", "continue-on-disconnect", "auto-check-fold", "sit-out-after-two-hands"],
} as const;
