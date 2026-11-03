import pg from "pg";

// Making the database itself, for CREATE_DATABASE_IF_MISSING=true (docker-entrypoint.sh, src/migrate.ts). The `prisma migrate deploy` the image used to
// run did this on its own, which turned a typo in a database name into a new, empty database; the image no longer has that CLI, and a person who really
// wants a database made for them says so with the setting. Kept free of config.ts imports so it can be tested on its own.

/** The database a connection string names. */
export function databaseNameOf(connectionString: string): string {
  const name = decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, ""));
  if (name === "") throw new Error("DATABASE_URL does not name a database (nothing after the host and port).");
  return name;
}

/** `"name"` as a Postgres identifier: quoted, with any quote inside doubled, so no name can end the statement. */
export const quoteIdentifier = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/**
 * Makes the database a connection string names if it does not exist, by asking the server's `postgres` database. Returns whether it made one. The login
 * in the string must be allowed to create databases; if it is not, Postgres says so and that is what the person sees.
 */
export async function createDatabaseIfMissing(connectionString: string): Promise<boolean> {
  const name = databaseNameOf(connectionString);
  const maintenance = new URL(connectionString);
  maintenance.pathname = "/postgres";
  const client = new pg.Client({ connectionString: maintenance.toString() });
  await client.connect();
  try {
    const found = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (found.rowCount) return false;
    await client.query(`CREATE DATABASE ${quoteIdentifier(name)}`);
    return true;
  } finally {
    await client.end().catch(() => undefined);
  }
}
