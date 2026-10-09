import { createHash } from "node:crypto";

const HIBP_RANGE_URL = "https://api.pwnedpasswords.com/range/";
const TIMEOUT_MS = 3000;

/**
 * Checks a candidate password against the Have I Been Pwned "Pwned
 * Passwords" breach corpus, via the k-anonymity range API - only the
 * first 5 hex characters of the password's SHA-1 hash are ever sent, never
 * the password itself or its full hash; the full set of matching suffixes
 * for that prefix comes back and gets checked locally. See
 * https://haveibeenpwned.com/API/v3#PwnedPasswords.
 *
 * Fails open (returns false - "not known to be breached") on any network
 * error, timeout, or non-200 response - an outage of this external API,
 * or a deployment with no outbound internet, should never block
 * registration; it just means this specific check didn't happen that
 * time. Config-gated (server/src/config.ts's passwordBreachCheckEnabled)
 * for deployments that don't want the outbound call attempted at all.
 */
export async function isPasswordBreached(password: string): Promise<boolean> {
  const sha1 = createHash("sha1").update(password).digest("hex").toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${HIBP_RANGE_URL}${prefix}`, { signal: controller.signal });
    if (!res.ok) return false;
    const body = await res.text();
    return body
      .split("\n")
      .some((line) => line.split(":")[0]?.trim().toUpperCase() === suffix);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
