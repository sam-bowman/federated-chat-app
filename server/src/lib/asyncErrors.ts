import express from "express";

// Express 4 does not look at what a route handler returns, so an `async`
// handler that throws (or awaits a rejected promise) produces an unhandled
// rejection - which terminates the Node process by default. One bad request
// then takes the server down for everyone connected to it.
//
// installAsyncErrorHandling() makes every router's route-registering methods
// (get/post/.../use/all) forward a rejected promise to `next(err)`, so it reaches
// the error-handling middleware in app.ts exactly like a synchronous throw does.
// It patches the methods on `express.Router` itself - which every router created
// by `express.Router()` inherits from - once, at startup, from
// lib/installAsyncErrors.ts, imported first in app.ts so it runs before any route
// module registers a handler. The route modules therefore keep using plain
// `express.Router()`, which matters beyond taste: CodeQL's rate-limiting
// analysis (js/missing-rate-limiting) only recognises routers created that way,
// and an earlier wrapper-function version of this fix made it report every route
// as unprotected, although app.ts mounts a rate limiter in front of them all.

const REGISTERING_METHODS = ["all", "get", "post", "put", "patch", "delete", "head", "options", "use"] as const;
const INSTALLED = Symbol.for("federated-chat-app.asyncErrorHandling");

type AnyHandler = (...args: unknown[]) => unknown;

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as PromiseLike<unknown>).then === "function";
}

function wrap(arg: unknown): unknown {
  if (Array.isArray(arg)) return arg.map(wrap);
  if (typeof arg !== "function") return arg; // a path, regex, or array of paths
  // A mounted sub-router is itself a function(req, res, next); it is
  // synchronous and already protects its own handlers.
  if ("handle" in arg) return arg;
  // Four parameters is how Express recognises an error-handling middleware.
  if (arg.length === 4) return arg;
  const handler = arg as AnyHandler;
  return (req: unknown, res: unknown, next: (err?: unknown) => void) => {
    const result = handler(req, res, next);
    if (isThenable(result)) result.then(undefined, next);
    return result;
  };
}

/** Idempotent: calling it again (a test file, a hot reload) does not wrap twice. */
export function installAsyncErrorHandling(): void {
  const proto = express.Router as unknown as Record<string | symbol, unknown>;
  if (proto[INSTALLED]) return;
  for (const method of REGISTERING_METHODS) {
    const original = proto[method] as AnyHandler;
    proto[method] = function (this: unknown, ...args: unknown[]) {
      return original.apply(this, args.map(wrap));
    };
  }
  proto[INSTALLED] = true;
}
