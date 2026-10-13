import cors from "cors";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { corsOptions, parseCorsOrigins } from "./corsOrigins.js";

describe("parseCorsOrigins", () => {
  it("parses a single origin, as before", () => {
    expect(parseCorsOrigins("https://chat.example.com")).toEqual(["https://chat.example.com"]);
  });

  it("parses a comma-separated list, ignoring spaces and empty entries", () => {
    expect(parseCorsOrigins("https://chat.example.com, http://tauri.localhost,,")).toEqual([
      "https://chat.example.com",
      "http://tauri.localhost",
    ]);
  });

  it("forgives a trailing slash, the commonest mistake, and de-duplicates", () => {
    expect(parseCorsOrigins("https://chat.example.com/,https://chat.example.com")).toEqual(["https://chat.example.com"]);
  });

  it("keeps a non-default port as part of the origin", () => {
    expect(parseCorsOrigins("http://localhost:5173")).toEqual(["http://localhost:5173"]);
  });

  it("rejects an entry with a path, which a browser's Origin header could never match", () => {
    expect(() => parseCorsOrigins("https://chat.example.com/app")).toThrow(/not a bare origin/);
  });

  it("rejects entries that are not http(s) origins", () => {
    expect(() => parseCorsOrigins("chat.example.com")).toThrow(/not a bare origin/);
    expect(() => parseCorsOrigins("ftp://chat.example.com")).toThrow(/not a bare origin/);
    expect(() => parseCorsOrigins("https://chat.example.com?x=1")).toThrow(/not a bare origin/);
  });

  it("names the offending entry rather than failing the whole list vaguely", () => {
    expect(() => parseCorsOrigins("https://ok.example.com,oops")).toThrow(/"oops"/);
  });

  it("rejects an empty value", () => {
    expect(() => parseCorsOrigins("")).toThrow(/empty/);
    expect(() => parseCorsOrigins(" , ")).toThrow(/empty/);
  });

  it("accepts * only on its own", () => {
    expect(parseCorsOrigins("*")).toEqual(["*"]);
    expect(() => parseCorsOrigins("*,https://chat.example.com")).toThrow(/cannot be combined/);
  });
});

describe("corsOptions applied to the cors middleware", () => {
  const app = express();
  app.use(cors(corsOptions(["https://chat.example.com", "http://tauri.localhost"])));
  app.get("/x", (_req, res) => res.json({ ok: true }));

  it("echoes whichever listed origin made the request", async () => {
    const web = await request(app).get("/x").set("Origin", "https://chat.example.com");
    expect(web.headers["access-control-allow-origin"]).toBe("https://chat.example.com");
    const desktop = await request(app).get("/x").set("Origin", "http://tauri.localhost");
    expect(desktop.headers["access-control-allow-origin"]).toBe("http://tauri.localhost");
    expect(desktop.headers["access-control-allow-credentials"]).toBe("true");
    expect(desktop.headers.vary).toContain("Origin");
  });

  it("sends no allow-origin header to an origin that is not listed", async () => {
    const res = await request(app).get("/x").set("Origin", "https://evil.example");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("uses a wildcard only when configured as exactly *", async () => {
    const open = express();
    open.use(cors(corsOptions(["*"])));
    open.get("/x", (_req, res) => res.json({}));
    const res = await request(open).get("/x").set("Origin", "https://anything.example");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    // A wildcard is never combined with credentials.
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("sends nothing to a request with no Origin header (curl, same-origin)", async () => {
    const res = await request(app).get("/x");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
