import { describe, expect, it } from "vitest";
import { isMissingDatabase } from "./databaseErrors.js";

// The shapes are what Prisma 7's pg adapter really throws, recorded from a run against Postgres (a missing database; a wrong password).
const missing = {
  code: "P2010",
  meta: { driverAdapterError: { name: "DriverAdapterError", cause: { originalCode: "3D000", originalMessage: 'database "x" does not exist', kind: "DatabaseDoesNotExist", db: "x" } } },
};
const wrongPassword = { code: "P2010", meta: { driverAdapterError: { cause: { originalCode: "28P01", originalMessage: "password authentication failed", kind: "AuthenticationFailed" } } } };

describe("isMissingDatabase", () => {
  it("recognises the error for a database that does not exist", () => {
    expect(isMissingDatabase(missing)).toBe(true);
  });

  it("recognises it by Postgres's own code when the kind is not named", () => {
    expect(isMissingDatabase({ meta: { driverAdapterError: { cause: { originalCode: "3D000" } } } })).toBe(true);
  });

  it("is not any other failure to connect: a wrong password, a refused connection, an unrelated error, nothing", () => {
    expect(isMissingDatabase(wrongPassword)).toBe(false);
    expect(isMissingDatabase({ code: "ECONNREFUSED" })).toBe(false);
    expect(isMissingDatabase(new Error("boom"))).toBe(false);
    expect(isMissingDatabase(null)).toBe(false);
    expect(isMissingDatabase(undefined)).toBe(false);
  });
});
