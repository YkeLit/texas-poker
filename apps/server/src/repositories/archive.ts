import type { PrismaClient } from "@prisma/client";
import type { ChatMessage, HandResult } from "@texas-poker/shared";
import type { StoredRoom } from "@ykelit/games-room-runtime";
import type { TexasState } from "../shared-runtime";

export interface RoomArchive {
  ensureRoom(room: StoredRoom<TexasState>): Promise<void>;
  saveChat(roomId: string, message: ChatMessage): Promise<void>;
  saveHand(roomId: string, result: HandResult): Promise<void>;
  close(): Promise<void>;
}

export class NoopRoomArchive implements RoomArchive {
  async ensureRoom(): Promise<void> {}
  async saveChat(): Promise<void> {}
  async saveHand(): Promise<void> {}
  async close(): Promise<void> {}
}

export class PrismaRoomArchive implements RoomArchive {
  constructor(private readonly prisma: PrismaClient) {}

  async ensureRoom(room: StoredRoom<TexasState>): Promise<void> {
    await this.prisma.runtimeRoomArchive.upsert({
      where: { roomId: room.id },
      create: {
        roomId: room.id,
        roomCode: room.code,
        hostParticipantId: room.hostParticipantId,
        config: room.state.engine.config,
        createdAt: new Date(room.createdAt),
      },
      update: { hostParticipantId: room.hostParticipantId, config: room.state.engine.config },
    });
  }

  async saveChat(roomId: string, message: ChatMessage): Promise<void> {
    await this.prisma.runtimeChatLog.upsert({
      where: { messageId: message.id },
      create: {
        messageId: message.id,
        roomId,
        senderParticipantId: message.senderSessionId,
        nickname: message.senderNickname,
        type: message.type,
        content: message.content,
        createdAt: new Date(message.createdAt),
      },
      update: {},
    });
  }

  async saveHand(roomId: string, result: HandResult): Promise<void> {
    await this.prisma.runtimeHandHistory.upsert({
      where: { roomId_handNumber: { roomId, handNumber: result.handNumber } },
      create: { roomId, handNumber: result.handNumber, payload: result as unknown as object },
      update: { payload: result as unknown as object },
    });
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
