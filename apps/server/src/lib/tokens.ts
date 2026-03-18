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

export function createSignedToken<T extends Record<string, unknown>>(payload: T, secret: string): string {
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
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

  return JSON.parse(decodeBase64Url(encodedPayload)) as T;
}
