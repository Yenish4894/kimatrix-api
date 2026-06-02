import crypto from "node:crypto";

export function generateRandomToken(byteLength = 24): string {
  return crypto.randomBytes(byteLength).toString("base64url");
}

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}
