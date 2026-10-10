import crypto from "node:crypto";

// Split out from auth.ts (which imports config.js, and so can't be
// unit-tested in the plain vitest environment with no DATABASE_URL set -
// see diskStorage.ts/nonceCacheAdapters.ts for the same split, same reason)
// so recoveryCodes.ts can reuse this without pulling config.js in
// transitively just by importing auth.ts.
export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}
