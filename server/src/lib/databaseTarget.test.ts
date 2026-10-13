import { describe, expect, it } from "vitest";
import { databaseSummary, describeDatabaseTarget, formatDatabaseTarget, missingDatabaseMessage } from "./databaseTarget.js";

describe("describeDatabaseTarget", () => {
  it("reads the database, host and port from a connection URL", () => {
    expect(describeDatabaseTarget("postgresql://chat:pw@postgres:5432/chat")).toEqual({ name: "chat", host: "postgres", port: "5432" });
  });

  it("defaults the port and ignores query parameters such as ?schema=", () => {
    expect(describeDatabaseTarget("postgresql://u:p@db.example.com/chatdb?schema=public&sslmode=require")).toEqual({
      name: "chatdb",
      host: "db.example.com",
      port: "5432",
    });
  });

  it("accepts the postgres:// scheme and a percent-encoded database name", () => {
    expect(describeDatabaseTarget("postgres://u:p@h:6543/my%20db")).toEqual({ name: "my db", host: "h", port: "6543" });
  });

  it("prefers a unix-socket directory given as ?host=, which is what the client connects to", () => {
    expect(describeDatabaseTarget("postgresql://u:p@localhost/chat?host=/var/run/postgresql")?.host).toBe("/var/run/postgresql");
  });

  it("says less, rather than guessing, for a URL with an empty authority", () => {
    expect(describeDatabaseTarget("postgresql://u:p@/chat?host=/var/run/postgresql")).toBeNull();
  });

  it("returns null for anything it cannot read, rather than guessing", () => {
    expect(describeDatabaseTarget("not a url")).toBeNull();
    expect(describeDatabaseTarget("mysql://u:p@h/db")).toBeNull();
    expect(describeDatabaseTarget("postgresql://u:p@h:5432")).toBeNull();
    expect(describeDatabaseTarget("postgresql://u:p@h:5432/")).toBeNull();
  });

  it("never exposes the username or password in anything it formats", () => {
    const url = "postgresql://chat:hunter2-secret@postgres:5432/chat";
    const text = [formatDatabaseTarget(describeDatabaseTarget(url)!), missingDatabaseMessage(url), databaseSummary(url, 3)].join("\n");
    expect(text).not.toContain("hunter2-secret");
    expect(text).not.toContain("chat:");
  });
});

describe("missingDatabaseMessage", () => {
  it("names the database and host, and says what to do", () => {
    const message = missingDatabaseMessage("postgresql://chat:pw@postgres:5432/chatt");
    expect(message).toContain('database "chatt" on postgres:5432 does not exist');
    expect(message).toContain("CREATE_DATABASE_IF_MISSING=true");
    expect(message).toContain("typo");
  });

  it("still says something useful for a URL it cannot read", () => {
    expect(missingDatabaseMessage("weird")).toContain("the database named in DATABASE_URL does not exist");
  });
});

describe("databaseSummary", () => {
  it("reports how many accounts there are", () => {
    expect(databaseSummary("postgresql://u:p@postgres:5432/chat", 12)).toBe('Connected to database "chat" on postgres:5432: 12 local account(s).');
  });

  it("flags an empty database without alarming a first start", () => {
    const line = databaseSummary("postgresql://u:p@postgres:5432/chat", 0);
    expect(line).toContain("no accounts yet");
    expect(line).toContain("right for a first start");
    expect(line).toContain("check the database name in DATABASE_URL");
  });
});
