import type { CreateRoomResponse, ErrorReportPayload, JoinRoomResponse, RoomConfig, RoomSummary } from "@texas-poker/shared";

const JSON_HEADERS = { "Content-Type": "application/json" };

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { credentials: "include", ...init });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string | { message?: string }; message?: string };
    const message = typeof payload.error === "string" ? payload.error : payload.error?.message ?? payload.message;
    throw Object.assign(new Error(message ?? `Request failed with status ${response.status}`), { status: response.status });
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function createRoom(nickname: string, config: RoomConfig) {
  return requestJson<CreateRoomResponse>("/api/v1/rooms", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ nickname, config }),
  });
}

export function joinRoom(roomCode: string, nickname: string) {
  return requestJson<JoinRoomResponse>("/api/v1/rooms/join", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ roomCode, nickname }),
  });
}

export function getActiveRoom(signal: AbortSignal = AbortSignal.timeout(8000)) {
  return requestJson<RoomSummary | { activeRoom: null }>("/api/v1/session/active-room", { signal });
}

export function leaveRoom(roomId: string) {
  return requestJson<void>(`/api/v1/rooms/${roomId}/leave`, { method: "POST", signal: AbortSignal.timeout(8000) });
}

export function reportClientError(payload: ErrorReportPayload) {
  return requestJson<{ accepted: boolean }>("/api/v1/reports/errors", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
}
