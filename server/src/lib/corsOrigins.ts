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
 * Options for the app-wide `cors()` middleware. With a list the middleware
 * answers a request only when its `Origin` is in it (echoing that origin back
 * and adding `Vary: Origin`); any other origin gets no CORS headers, which is
 * what makes a browser refuse to hand the response to that page.
 */
export function corsOptions(origins: string[]): CorsOptions {
  return { origin: origins.length === 1 && origins[0] === "*" ? "*" : origins, credentials: true };
}
