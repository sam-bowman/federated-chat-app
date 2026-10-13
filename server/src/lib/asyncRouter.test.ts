import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { Router } from "./asyncRouter.js";

// Builds a tiny app around a router created by the helper under test, with a
// final error handler that reports what reached it - no database involved.
function appWith(register: (router: ReturnType<typeof Router>) => void) {
  const router = Router();
  register(router);
  const app = express();
  app.use(router);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ caught: err instanceof Error ? err.message : String(err) });
  });
  return app;
}

describe("Router (async-safe)", () => {
  it("forwards a rejected promise from an async handler to the error handler", async () => {
    const app = appWith((r) =>
      r.get("/boom", async () => {
        throw new Error("async failure");
      })
    );
    const res = await request(app).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ caught: "async failure" });
  });

  it("forwards a rejection that happens after an await, not just a synchronous throw", async () => {
    const app = appWith((r) =>
      r.post("/later", async (_req, res) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await Promise.reject(new Error("rejected later"));
        res.json({ ok: true });
      })
    );
    const res = await request(app).post("/later");
    expect(res.body).toEqual({ caught: "rejected later" });
  });

  it("still handles synchronous throws and ordinary async success", async () => {
    const app = appWith((r) => {
      r.get("/sync-throw", () => {
        throw new Error("sync failure");
      });
      r.get("/fine", async (_req, res) => {
        res.json({ ok: true });
      });
    });
    expect((await request(app).get("/sync-throw")).body).toEqual({ caught: "sync failure" });
    expect((await request(app).get("/fine")).body).toEqual({ ok: true });
  });

  it("wraps async middleware passed alongside the handler, and handler arrays", async () => {
    const app = appWith((r) => {
      const failingMiddleware = async () => {
        throw new Error("middleware failure");
      };
      r.get("/mw", failingMiddleware, (_req, res) => res.json({ reached: true }));
      r.get("/array", [async () => Promise.reject(new Error("in array"))]);
    });
    expect((await request(app).get("/mw")).body).toEqual({ caught: "middleware failure" });
    expect((await request(app).get("/array")).body).toEqual({ caught: "in array" });
  });

  it("leaves four-argument error handlers alone, so they keep being treated as such", async () => {
    const app = appWith((r) => {
      r.get("/fail", async () => {
        throw new Error("original");
      });
      r.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
        res.status(418).json({ routerHandled: err.message });
      });
    });
    const res = await request(app).get("/fail");
    expect(res.status).toBe(418);
    expect(res.body).toEqual({ routerHandled: "original" });
  });

  it("protects handlers behind a mounted sub-router and an app.use path", async () => {
    const inner = Router();
    inner.get("/x", async () => {
      throw new Error("inner failure");
    });
    const outer = Router();
    outer.use("/inner", inner);
    const app = express();
    app.use(outer);
    app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      res.status(500).json({ caught: err.message });
    });
    expect((await request(app).get("/inner/x")).body).toEqual({ caught: "inner failure" });
  });

  it("supports method chaining like a normal router", () => {
    const router = Router();
    expect(router.get("/a", (_req, res) => res.end())).toBe(router);
    expect(router.use((_req, _res, next) => next())).toBe(router);
  });
});
