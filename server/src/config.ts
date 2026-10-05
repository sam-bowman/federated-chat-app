import "dotenv/config";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parsePeerOverrides(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  // The domain portion of this homeserver's identities, e.g. "@sam:<domain>".
  // Single-server today, but every identity/object already carries this so a
  // second, independently-run homeserver can federate later without any
  // existing IDs changing shape.
  domain: required("SERVER_DOMAIN", "localhost"),
  serverName: process.env.SERVER_NAME ?? "My Chat Server",
  databaseUrl: required("DATABASE_URL"),
  jwtAccessSecret: required("JWT_ACCESS_SECRET", "dev-insecure-access-secret-change-me"),
  jwtRefreshSecret: required("JWT_REFRESH_SECRET", "dev-insecure-refresh-secret-change-me"),
  accessTokenTtlSeconds: 15 * 60,
  refreshTokenTtlDays: 30,
  registrationEnabled: (process.env.REGISTRATION_ENABLED ?? "true") === "true",
  uploadsDir: process.env.UPLOADS_DIR ?? "uploads",
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 8 * 1024 * 1024),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  protocolVersion: "0.1.0",

  // This server's own publicly-reachable address. Real deployments would
  // just be `https://${domain}`; local dev needs it set explicitly since
  // nothing resolves `alice.test` to `http://localhost:4000` on its own.
  baseUrl: process.env.PUBLIC_BASE_URL ?? `http://localhost:${Number(process.env.PORT ?? 4000)}`,

  // Dev-only override map ({"bob.test":"http://localhost:4001"}) so two
  // local instances can discover each other without real DNS/TLS. A real
  // deployment leaves this unset and discovery hits `https://{domain}`
  // directly.
  federationPeerOverrides: parsePeerOverrides(process.env.FEDERATION_PEER_OVERRIDES),
};
