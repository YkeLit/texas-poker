import { createHmac, timingSafeEqual } from "node:crypto";

function encodeBase64Url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

function decodeBase64Url(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createSignedToken<T extends Record<string, unknown>>(payload: T, secret: string, ttlSeconds = 60): string {
  const now = Math.floor(Date.now() / 1000);
  const encodedPayload = encodeBase64Url(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }));
  const signature = sign(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

export function verifySignedToken<T extends Record<string, unknown>>(token: string, secret: string): T {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) {
    throw new Error("Invalid token format");
  }

  const expectedSignature = sign(encodedPayload, secret);
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    throw new Error("Token signature mismatch");
  }

  const payload = JSON.parse(decodeBase64Url(encodedPayload)) as T & { exp?: number };
  if (typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error("Token expired");
  }
  return payload;
}
