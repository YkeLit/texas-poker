import { z } from "zod";

export const STARTING_STACK_PRESETS = [1000, 2000, 5000] as const;
export const BLIND_PRESETS = [
  { smallBlind: 10, bigBlind: 20 },
  { smallBlind: 20, bigBlind: 40 },
  { smallBlind: 50, bigBlind: 100 },
] as const;
export const ACTION_TIME_PRESETS = [15, 20, 30] as const;
export const MAX_TABLE_PLAYERS = 9;
export const MIN_TABLE_PLAYERS = 2;
export const CHAT_MESSAGE_LIMIT = 160;
export const CHAT_THROTTLE_MS = 1_000;
export const EMOJI_THROTTLE_MS = 800;
export const NEXT_HAND_DELAY_MS = 5_000;
export const RECONNECT_GRACE_HANDS = 2;

export type Suit = "clubs" | "diamonds" | "hearts" | "spades";
export type TableStage = "waiting" | "preflop" | "flop" | "turn" | "river" | "showdown";
export type BettingRound = "preflop" | "flop" | "turn" | "river";
export type PlayerPresence = "connected" | "disconnected";
export type PlayerStatus = "waiting" | "active" | "folded" | "all-in" | "out" | "sit-out";
export type ActionType = "fold" | "check" | "call" | "bet" | "raise" | "all_in";
export type ChatMessageType = "chat" | "emoji" | "system";
export type RecentActionTone = "neutral" | "safe" | "aggressive";

export interface Card {
  rank: number;
  suit: Suit;
}

export interface RoomConfig {
  maxPlayers: number;
  startingStack: number;
  smallBlind: number;
  bigBlind: number;
  actionTimeSeconds: number;
  rebuyCooldownHands: number;
}

export interface AvailableAction {
  type: ActionType;
  minAmount?: number;
  maxAmount?: number;
}

export interface RecentPlayerAction {
  label: string;
  tone: RecentActionTone;
}

export interface PublicPlayerState {
  nickname: string;
  seatIndex: number;
  stack: number;
  currentBet: number;
  totalCommitted: number;
  ready: boolean;
  isHost: boolean;
  status: PlayerStatus;
  presence: PlayerPresence;
  canAct: boolean;
  holeCardCount: number;
  revealedCards?: Card[];
  missedHands: number;
  lastAction?: RecentPlayerAction;
  rebuyRemainingHands: number;
  canRebuy: boolean;
}

export interface SeatState {
  seatIndex: number;
  occupied: boolean;
  player?: PublicPlayerState;
}

export interface PotState {
  amount: number;
  eligibleSeatIndexes: number[];
}

export interface ChatMessage {
  id: string;
  type: ChatMessageType;
  content: string;
  createdAt: string;
  senderSessionId?: string;
  senderNickname?: string;
}

export interface HandResult {
  handNumber: number;
  board: Card[];
  pots: PotState[];
  winners: Array<{
    seatIndex: number;
    nickname: string;
    amount: number;
    rankName: string;
    cards: Card[];
  }>;
}

export interface RoomSnapshot {
  roomCode: string;
  config: RoomConfig;
  handNumber: number;
  stage: TableStage;
  dealerSeatIndex: number | null;
  smallBlindSeatIndex: number | null;
  bigBlindSeatIndex: number | null;
  actingSeatIndex: number | null;
  actionDeadlineAt: string | null;
  minRaiseTo: number | null;
  currentBet: number;
  board: Card[];
  pots: PotState[];
  seats: SeatState[];
  messages: ChatMessage[];
  yourSeatIndex?: number | null;
  yourHoleCards?: Card[];
  yourAvailableActions: AvailableAction[];
  lastResult?: HandResult;
  startedAt?: string;
}

export interface GuestSession {
  sessionId: string;
  nickname: string;
  resumeToken: string;
  createdAt: string;
}

export interface ReconnectPayload {
  roomCode: string;
  sessionId: string;
  resumeToken: string;
}

export interface RoomSummary {
  roomCode: string;
  config: RoomConfig;
  stage: TableStage;
  connectedPlayers: number;
  seatedPlayers: number;
  hasStarted: boolean;
}

export interface JoinRoomResponse {
  roomCode: string;
  wsToken: string;
  snapshot: RoomSnapshot;
}

export interface CreateRoomResponse {
  roomCode: string;
  snapshot: RoomSnapshot;
}

export interface PlayerActionCommand {
  type: ActionType;
  amount?: number;
}

export interface SocketAuthedPayload {
  roomCode: string;
  sessionId: string;
}

export interface ErrorReportPayload {
  sessionId: string;
  resumeToken: string;
  roomCode?: string;
  message: string;
  stack?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export const cardSchema = z.object({
  rank: z.number().int().min(2).max(14),
  suit: z.enum(["clubs", "diamonds", "hearts", "spades"]),
});

export const roomConfigSchema = z.object({
  maxPlayers: z.number().int().min(MIN_TABLE_PLAYERS).max(MAX_TABLE_PLAYERS),
  startingStack: z.number().int().positive(),
  smallBlind: z.number().int().positive(),
  bigBlind: z.number().int().positive(),
  actionTimeSeconds: z.number().int().positive(),
  rebuyCooldownHands: z.number().int().min(0),
}).refine((value) => value.bigBlind >= value.smallBlind, {
  message: "bigBlind must be greater than or equal to smallBlind",
  path: ["bigBlind"],
});

export const createGuestSessionSchema = z.object({
  nickname: z.string().trim().min(1).max(20),
});

export const updateGuestSessionSchema = z.object({
  nickname: z.string().trim().min(1).max(20),
  resumeToken: z.string().min(1),
});

export const createRoomSchema = z.object({
  sessionId: z.string().min(1),
  resumeToken: z.string().min(1),
  config: roomConfigSchema,
});

export const joinRoomSchema = z.object({
  sessionId: z.string().min(1),
  resumeToken: z.string().min(1),
});

export const reconnectSchema = z.object({
  roomCode: z.string().trim().length(6),
  sessionId: z.string().min(1),
  resumeToken: z.string().min(1),
});

export const playerActionSchema = z.object({
  type: z.enum(["fold", "check", "call", "bet", "raise", "all_in"]),
  amount: z.number().int().positive().optional(),
});

export const seatActionSchema = z.object({
  seatIndex: z.number().int().min(0).max(MAX_TABLE_PLAYERS - 1),
});

export const chatMessageSchema = z.object({
  content: z.string().trim().min(1).max(CHAT_MESSAGE_LIMIT),
});

export const emojiMessageSchema = z.object({
  content: z.string().trim().min(1).max(8),
});

export const errorReportSchema = z.object({
  sessionId: z.string().min(1),
  resumeToken: z.string().min(1),
  roomCode: z.string().trim().length(6).optional(),
  message: z.string().trim().min(1),
  stack: z.string().optional(),
  metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});

export const blindPresetSchema = z.object({
  smallBlind: z.number().int().positive(),
  bigBlind: z.number().int().positive(),
});

export function isBlindPreset(config: RoomConfig): boolean {
  return BLIND_PRESETS.some((preset) => preset.smallBlind === config.smallBlind && preset.bigBlind === config.bigBlind);
}

export function getPlayerLabel(player?: Pick<PublicPlayerState, "nickname" | "seatIndex">): string {
  if (!player) {
    return "空位";
  }
  return `${player.nickname} · ${player.seatIndex + 1}号位`;
}
