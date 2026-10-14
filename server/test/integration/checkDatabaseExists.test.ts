import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Runs the real pre-start check (src/checkDatabaseExists.ts, which docker-entrypoint.sh runs
// before `prisma migrate deploy`) as a separate process against the test Postgres, because the
// thing it guards against - `prisma migrate deploy` quietly CREATING a missing database - is
// what turned a typo in DATABASE_URL into a new, empty database with a new federation
// identity. The server this runs against is the CI/dev one: DATABASE_URL names chat_test.
function runCheck(databaseUrl: string) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/checkDatabaseExists.ts"], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function withDatabase(name: string): string {
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${name}`;
  return url.toString();
}

describe("checkDatabaseExists (run by the container entrypoint)", () => {
  it("passes for a database that exists", () => {
    const result = runCheck(process.env.DATABASE_URL!);
    expect(result.output).toBe("");
    expect(result.status).toBe(0);
  });

  it("refuses a database that does not exist, naming it and the way out", () => {
    const result = runCheck(withDatabase("chat_typo_that_does_not_exist"));
    expect(result.status).toBe(1);
    expect(result.output).toContain('database "chat_typo_that_does_not_exist"');
    expect(result.output).toContain("does not exist");
    expect(result.output).toContain("CREATE_DATABASE_IF_MISSING=true");
    // (That the URL's password is never printed is checked by databaseTarget.test.ts: the test
    // database's own password is just "chat", which would match the word everywhere here.)
  });

  it("leaves an unreachable server to prisma migrate deploy to report", () => {
    const url = new URL(process.env.DATABASE_URL!);
    url.port = "1"; // nothing listens here
    // Give up after a second instead of the default wait: on some systems (Windows) a refused connection
    // is retried for several seconds, and the outcome being checked - report nothing, exit 0 - is the same.
    url.searchParams.set("connect_timeout", "1");
    const result = runCheck(url.toString());
    expect(result.status).toBe(0);
    expect(result.output).toBe("");
  });
});
