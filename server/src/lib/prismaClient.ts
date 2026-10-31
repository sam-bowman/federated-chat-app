import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

/**
 * How long to wait for a connection from the pool, and for a new one to open, before a query fails. Prisma 5's engine waited 10 s for a free
 * connection and 5 s to open one; the pg driver's own default is to wait for ever, which would hang a request instead of failing it.
 */
export const DATABASE_CONNECT_TIMEOUT_MS = 10_000;

/**
 * A Prisma client for one database URL. Prisma 7 has no query engine of its own: it talks to Postgres through the `pg` driver (an adapter), so
 * every place that makes a client makes it here, and the URL is passed in, never read from the environment (Prisma 5 read `DATABASE_URL` and
 * loaded `.env` itself; neither happens now).
 */
export function createPrismaClient(connectionString: string | undefined): PrismaClient {
  const adapter = new PrismaPg(
    { connectionString, connectionTimeoutMillis: DATABASE_CONNECT_TIMEOUT_MS },
    // An idle connection that the database drops (a restart, a failover) is an 'error' event on the pool: unhandled, it ends the process.
    { onPoolError: (err) => console.error("[db] connection pool error:", err) }
  );
  return new PrismaClient({ adapter });
}
