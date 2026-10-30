import express from "express";

// Where each router was mounted (`app.use("/api/v1/auth", authRouter)`), recorded as the mount is made.
//
// apiReference.test.ts walks the app's routers to check every route is in the reference, and for that it has to know the path a router
// sits at. Express 4 kept a regular expression on the mount's layer, which the test turned back into a path; Express 5 keeps neither the
// string nor an expression there (#276), so the only moment the path is known is when `use` is called. This wraps `use` on the router
// prototype (`app.use` goes through it) and remembers the path against the router it was given.
//
// Import this BEFORE the app (ES imports run in order, so the app's own `use` calls come after), as the first import of the test.
export const mounts = new WeakMap<object, string>();

// Every router has a prototype of its own over the shared one that holds `use` (router 2.x), so go up to the object that owns it.
let proto = Object.getPrototypeOf(express.Router()) as { use: (...args: unknown[]) => unknown } | null;
while (proto && !Object.prototype.hasOwnProperty.call(proto, "use")) proto = Object.getPrototypeOf(proto);
if (!proto) throw new Error("recordMounts: could not find where Express keeps Router.use");
const original = proto.use;
proto.use = function (this: unknown, ...args: unknown[]) {
  if (typeof args[0] === "string") for (const handler of args.slice(1)) if (typeof handler === "function") mounts.set(handler, args[0]);
  return original.apply(this, args);
};
