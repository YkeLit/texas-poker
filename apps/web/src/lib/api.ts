import type {
  CreateRoomResponse,
  ErrorReportPayload,
  GuestSession,
  JoinRoomResponse,
  RoomConfig,
  RoomSummary,
} from "@texas-poker/shared";

const JSON_HEADERS = {
  "Content-Type": "application/json",
};

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `Request failed with status ${response.status}`);
  }
  return (await response.json()) as T;
}

export function createGuestSession(nickname: string) {
  return requestJson<GuestSession>("/api/v1/guest/sessions", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ nickname }),
  });
}

export function updateGuestSessionNickname(sessionId: string, nickname: string, resumeToken: string) {
  return requestJson<GuestSession>(`/api/v1/guest/sessions/${sessionId}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ nickname, resumeToken }),
  });
}

export function createRoom(sessionId: string, resumeToken: string, config: RoomConfig) {
  return requestJson<CreateRoomResponse>("/api/v1/rooms", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ sessionId, resumeToken, config }),
  });
}

export function joinRoom(roomCode: string, sessionId: string, resumeToken: string) {
  return requestJson<JoinRoomResponse>(`/api/v1/rooms/${roomCode}/join`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ sessionId, resumeToken }),
  });
}

export function getRoomSummary(roomCode: string) {
  return requestJson<RoomSummary>(`/api/v1/rooms/${roomCode}`);
}

export function reportClientError(payload: ErrorReportPayload) {
  return requestJson<{ accepted: boolean }>("/api/v1/reports/errors", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
}
