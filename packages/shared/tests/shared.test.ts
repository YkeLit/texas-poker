import { describe, expect, it } from "vitest";
import { BLIND_PRESETS, isBlindPreset, roomConfigSchema } from "../src";

describe("shared schemas", () => {
  it("accepts supported blind presets", () => {
    const parsed = roomConfigSchema.parse({
      maxPlayers: 6,
      startingStack: 1000,
      smallBlind: BLIND_PRESETS[0].smallBlind,
      bigBlind: BLIND_PRESETS[0].bigBlind,
      actionTimeSeconds: 15,
    });

    expect(isBlindPreset(parsed)).toBe(true);
  });

  it("flags unsupported blind presets at the business-rule layer", () => {
    const parsed = roomConfigSchema.parse({
      maxPlayers: 6,
      startingStack: 1000,
      smallBlind: 25,
      bigBlind: 50,
      actionTimeSeconds: 15,
    });

    expect(isBlindPreset(parsed)).toBe(false);
  });
});
