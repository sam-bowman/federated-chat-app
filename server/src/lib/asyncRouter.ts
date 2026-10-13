import { Router as ExpressRouter, type RouterOptions } from "express";

// Express 4 does not look at what a handler returns, so an `async` route
// handler that throws (or awaits a rejected promise) produces an unhandled
// rejection - which terminates the Node process by default. One bad request
// then takes the server down for everyone connected to it.
//
// `Router()` here is a drop-in replacement for express's own `Router()` whose
// route-registering methods forward a rejected promise to `next(err)`, so it
// reaches the error-handling middleware in app.ts like a synchronous throw
// does. It is scoped to routers created through it (no monkey-patching of
// Express itself) and has no dependencies.

const REGISTERING_METHODS = ["all", "get", "post", "put", "patch", "delete", "head", "options", "use"] as const;

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
  const wrapped = (req: unknown, res: unknown, next: (err?: unknown) => void) => {
    const result = handler(req, res, next);
    if (isThenable(result)) result.then(undefined, next);
    return result;
  };
  return wrapped;
}

export function Router(options?: RouterOptions): ExpressRouter {
  const router = ExpressRouter(options);
  const target = router as unknown as Record<string, AnyHandler>;
  for (const method of REGISTERING_METHODS) {
    const original = target[method].bind(router);
    target[method] = (...args: unknown[]) => original(...args.map(wrap));
  }
  return router;
}
