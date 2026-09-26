import crypto from "node:crypto";

export function generateRandomToken(byteLength = 24): string {
  return crypto.randomBytes(byteLength).toString("base64url");
}
