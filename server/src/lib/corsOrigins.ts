import type { CorsOptions } from "cors";

// CORS_ORIGIN is a comma-separated list of the browser origins allowed to call
// the API - typically the web client, and for a server that also serves the
// desktop app, that app's own origin (http://tauri.localhost on Windows).
// Parsed once at startup so a typo fails loudly instead of silently never
// matching any browser.
//
// Kept free of config.ts imports (which throw without DATABASE_URL) so it can be
// unit-tested without the rest of the server, like the other src/lib helpers.

/**
 * Splits and validates `CORS_ORIGIN`. Each entry must be a bare origin -
 * scheme, host and optional port, nothing else - because that is the only
 * shape a browser ever sends in the `Origin` header, so anything with a path
 * could never match. A single trailing slash is forgiven (the commonest
 * mistake). `*` is accepted only on its own.
 */
export function parseCorsOrigins(raw: string): string[] {
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (entries.length === 0) {
    throw new Error("CORS_ORIGIN is empty - list at least one origin, e.g. https://chat.example.com");
  }
  if (entries.includes("*")) {
    if (entries.length > 1) throw new Error("CORS_ORIGIN: '*' cannot be combined with other origins");
    return ["*"];
  }

  const origins: string[] = [];
  for (const entry of entries) {
    const candidate = entry.replace(/\/$/, "");
    let origin: string | undefined;
    try {
      const url = new URL(candidate);
      if ((url.protocol === "http:" || url.protocol === "https:") && url.origin === candidate) origin = url.origin;
    } catch {
      // falls through to the error below
    }
    if (!origin) {
      throw new Error(
        `CORS_ORIGIN entry "${entry}" is not a bare origin - use scheme://host[:port] with no path, e.g. https://chat.example.com`
      );
    }
    if (!origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

/**
 * Options for the app-wide `cors()` middleware.
 *
 * With a list, each request's `Origin` is checked against it: a listed origin is
 * echoed back (with `Vary: Origin`), anything else - including a request with no
 * Origin header - gets no CORS headers at all, which is what makes a browser
 * refuse to hand the response to that page.
 *
 * `*` (only ever the whole value, see parseCorsOrigins) opts in to answering every
 * origin, for a server meant to be used from clients hosted anywhere. It is sent
 * without credentials: a wildcard cannot be combined with credentialed requests
 * (browsers refuse that pairing), and nothing here uses cookies - clients send a
 * bearer token in the Authorization header - so there is nothing for it to expose.
 */
export function corsOptions(origins: string[]): CorsOptions {
  if (origins.length === 1 && origins[0] === "*") return { origin: "*" };
  const allowed = new Set(origins);
  return {
    origin: (requestOrigin, callback) => callback(null, requestOrigin !== undefined && allowed.has(requestOrigin)),
    credentials: true,
  };
}
