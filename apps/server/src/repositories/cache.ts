import type { RoomSnapshot } from "@texas-poker/shared";
import type Redis from "ioredis";

export interface CacheAdapter {
  saveRoomSnapshot(roomCode: string, snapshot: RoomSnapshot): Promise<void>;
  getRoomSnapshot(roomCode: string): Promise<RoomSnapshot | null>;
  saveResumeToken(sessionId: string, roomCode: string, resumeToken: string): Promise<void>;
  verifyResumeToken(sessionId: string, roomCode: string, resumeToken: string): Promise<boolean>;
  close(): Promise<void>;
}

export class MemoryCacheAdapter implements CacheAdapter {
  private snapshots = new Map<string, RoomSnapshot>();
  private resumeTokens = new Map<string, { roomCode: string; resumeToken: string }>();

  async saveRoomSnapshot(roomCode: string, snapshot: RoomSnapshot): Promise<void> {
    this.snapshots.set(roomCode, snapshot);
  }

  async getRoomSnapshot(roomCode: string): Promise<RoomSnapshot | null> {
    return this.snapshots.get(roomCode) ?? null;
  }

  async saveResumeToken(sessionId: string, roomCode: string, resumeToken: string): Promise<void> {
    this.resumeTokens.set(sessionId, { roomCode, resumeToken });
  }

  async verifyResumeToken(sessionId: string, roomCode: string, resumeToken: string): Promise<boolean> {
    const record = this.resumeTokens.get(sessionId);
    return record?.roomCode === roomCode && record.resumeToken === resumeToken;
  }

  async close(): Promise<void> {}
}

export class RedisCacheAdapter implements CacheAdapter {
  constructor(private readonly redis: Redis) {}

  async saveRoomSnapshot(roomCode: string, snapshot: RoomSnapshot): Promise<void> {
    await this.redis.set(`room:${roomCode}:snapshot`, JSON.stringify(snapshot));
  }

  async getRoomSnapshot(roomCode: string): Promise<RoomSnapshot | null> {
    const value = await this.redis.get(`room:${roomCode}:snapshot`);
    return value ? (JSON.parse(value) as RoomSnapshot) : null;
  }

  async saveResumeToken(sessionId: string, roomCode: string, resumeToken: string): Promise<void> {
    await this.redis.set(`session:${sessionId}:resume`, JSON.stringify({ roomCode, resumeToken }));
  }

  async verifyResumeToken(sessionId: string, roomCode: string, resumeToken: string): Promise<boolean> {
    const value = await this.redis.get(`session:${sessionId}:resume`);
    if (!value) {
      return false;
    }
    const parsed = JSON.parse(value) as { roomCode: string; resumeToken: string };
    return parsed.roomCode === roomCode && parsed.resumeToken === resumeToken;
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
