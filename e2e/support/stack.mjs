// The two homeservers and their clients, in one place: playwright.config.ts, run-server.mjs and the tests all read this.
// Ports and databases are not the dev ones (4000/4001, 5173/5174, chat_a/chat_b), so the suite can run while a developer's
// own demo is up.

/** @type {Record<"a" | "b", { domain: string, serverPort: number, clientPort: number, peer: { domain: string, serverPort: number } }>} */
export const SIDES = {
  a: { domain: "alice.test", serverPort: 4100, clientPort: 5273, peer: { domain: "bob.test", serverPort: 4101 } },
  b: { domain: "bob.test", serverPort: 4101, clientPort: 5274, peer: { domain: "alice.test", serverPort: 4100 } },
};

/**
 * Where Postgres is: the server of a developer's `docker compose up -d postgres` (host port 5433) unless
 * `E2E_DATABASE_URL_BASE` says otherwise (CI's service container is on 5432). No database name in it.
 */
export function databaseBase() {
  return (process.env.E2E_DATABASE_URL_BASE ?? "postgresql://chat:chat@localhost:5433").replace(/\/+$/, "");
}

export function databaseUrl(/** @type {"a" | "b"} */ side) {
  return `${databaseBase()}/chat_e2e_${side}`;
}
