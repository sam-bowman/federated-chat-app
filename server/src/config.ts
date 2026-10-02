import "dotenv/config";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
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
};
