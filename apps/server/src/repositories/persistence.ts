import type { PrismaClient } from "@prisma/client";
import type { ChatMessage, GuestSession, HandResult, RoomConfig } from "@texas-poker/shared";

export interface PersistenceAdapter {
  createGuestSession(session: GuestSession): Promise<void>;
  createRoom(roomCode: string, hostSessionId: string, config: RoomConfig): Promise<void>;
  saveChatMessage(roomCode: string, message: ChatMessage): Promise<void>;
  saveHandResult(roomCode: string, handResult: HandResult): Promise<void>;
  close(): Promise<void>;
}

export class NoopPersistenceAdapter implements PersistenceAdapter {
  async createGuestSession(): Promise<void> {}
  async createRoom(): Promise<void> {}
  async saveChatMessage(): Promise<void> {}
  async saveHandResult(): Promise<void> {}
  async close(): Promise<void> {}
}

export class PrismaPersistenceAdapter implements PersistenceAdapter {
  constructor(private readonly prisma: PrismaClient) {}

  async createGuestSession(session: GuestSession): Promise<void> {
    await this.prisma.guestSession.upsert({
      where: { sessionId: session.sessionId },
      create: {
        sessionId: session.sessionId,
        nickname: session.nickname,
        resumeToken: session.resumeToken,
        createdAt: new Date(session.createdAt),
      },
      update: {
        nickname: session.nickname,
        resumeToken: session.resumeToken,
      },
    });
  }

  async createRoom(roomCode: string, hostSessionId: string, config: RoomConfig): Promise<void> {
    await this.prisma.room.upsert({
      where: { roomCode },
      create: {
        roomCode,
        hostSessionId,
        maxPlayers: config.maxPlayers,
        startingStack: config.startingStack,
        smallBlind: config.smallBlind,
        bigBlind: config.bigBlind,
        actionTimeSeconds: config.actionTimeSeconds,
      },
      update: {
        hostSessionId,
        maxPlayers: config.maxPlayers,
        startingStack: config.startingStack,
        smallBlind: config.smallBlind,
        bigBlind: config.bigBlind,
        actionTimeSeconds: config.actionTimeSeconds,
      },
    });
  }

  async saveChatMessage(roomCode: string, message: ChatMessage): Promise<void> {
    await this.prisma.chatLog.create({
      data: {
        roomCode,
        senderSessionId: message.senderSessionId,
        nickname: message.senderNickname,
        type: message.type,
        content: message.content,
        createdAt: new Date(message.createdAt),
      },
    });
  }

  async saveHandResult(roomCode: string, handResult: HandResult): Promise<void> {
    await this.prisma.handHistory.upsert({
      where: {
        roomCode_handNumber: {
          roomCode,
          handNumber: handResult.handNumber,
        },
      },
      create: {
        roomCode,
        handNumber: handResult.handNumber,
        payload: handResult as unknown as object,
      },
      update: {
        payload: handResult as unknown as object,
      },
    });
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
