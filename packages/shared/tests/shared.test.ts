import { describe, expect, it } from "vitest";
import { roomConfigSchema } from "../src";

describe("shared schemas", () => {
  it("accepts custom room config values", () => {
    const parsed = roomConfigSchema.parse({
      maxPlayers: 6,
      startingStack: 1350,
      smallBlind: 15,
      bigBlind: 30,
      actionTimeSeconds: 18,
      rebuyCooldownHands: 2,
    });

    expect(parsed).toMatchObject({
      startingStack: 1350,
      smallBlind: 15,
      bigBlind: 30,
      actionTimeSeconds: 18,
      rebuyCooldownHands: 2,
    });
  });

  it("rejects invalid blind ordering", () => {
    expect(() =>
      roomConfigSchema.parse({
        maxPlayers: 6,
        startingStack: 1000,
        smallBlind: 50,
        bigBlind: 25,
        actionTimeSeconds: 15,
        rebuyCooldownHands: 1,
      }),
    ).toThrow();
  });
});
