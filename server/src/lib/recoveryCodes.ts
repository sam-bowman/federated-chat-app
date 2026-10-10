import crypto from "node:crypto";
import { sha256Hex } from "./hash.js";

export const RECOVERY_CODE_COUNT = 10;

/** Generates one-time 2FA recovery codes, shown to the user once (e.g. "4f2a-9c1e-77b3"). */
export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const raw = crypto.randomBytes(6).toString("hex");
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  });
}

export function hashRecoveryCode(code: string): string {
  return sha256Hex(code.trim().toLowerCase());
}
