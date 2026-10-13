// Which database a DATABASE_URL points at, for messages. Pure and free of config.ts
// imports (which throw without DATABASE_URL), like the other src/lib helpers, so the
// pre-start check script and the server can both use it.

export interface DatabaseTarget {
  name: string;
  host: string;
  port: string;
}

/**
 * The database name, host and port from a PostgreSQL connection URL - never the
 * username or password. Returns null when it isn't a URL we can read (a connection
 * string in another shape): callers then just say less.
 */
export function describeDatabaseTarget(databaseUrl: string): DatabaseTarget | null {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") return null;
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  // Prisma/libpq connect to a unix socket when ?host= is a directory, whatever the authority says.
  const host = url.searchParams.get("host") || url.hostname || "(local socket)";
  if (!name) return null;
  return { name, host, port: url.port || "5432" };
}

export function formatDatabaseTarget(target: DatabaseTarget): string {
  return `database "${target.name}" on ${target.host}:${target.port}`;
}

/** The message the pre-start check prints when the database named in DATABASE_URL does not exist. */
export function missingDatabaseMessage(databaseUrl: string): string {
  const target = describeDatabaseTarget(databaseUrl);
  const where = target ? formatDatabaseTarget(target) : "the database named in DATABASE_URL";
  return (
    `Refusing to start: ${where} does not exist.\n` +
    "Check the database name at the end of DATABASE_URL - a typo here used to be silently turned into a brand-new, empty " +
    "database (and a new federation identity), which looks like all your data has vanished. Create the database yourself, " +
    "or, to let the server create it on first start, set CREATE_DATABASE_IF_MISSING=true. " +
    "See docs/deployment/docker.md."
  );
}

/** One line for the server's startup log: where it is connected and whether there is any data yet. */
export function databaseSummary(databaseUrl: string, localAccounts: number): string {
  const target = describeDatabaseTarget(databaseUrl);
  const where = target ? formatDatabaseTarget(target) : "the configured database";
  if (localAccounts > 0) return `Connected to ${where}: ${localAccounts} local account(s).`;
  return (
    `Connected to ${where}: no accounts yet. That is right for a first start; if you expected existing data, ` +
    "check the database name in DATABASE_URL."
  );
}
