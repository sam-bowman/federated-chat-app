import type { Request } from "express";

/**
 * A path parameter, as the string it is. Express 5's types make every parameter `string | string[]` (a `*wildcard` parameter is a list),
 * but every route here names its parameters (`/:id`), and a named parameter that matched is always one string, so anything else means a
 * route was written wrongly: that is a 500 and a log line, never a guess. Read parameters through this, not `req.params.x` (a test
 * fails on the second), so there is one place that decides.
 */
export function param(req: Pick<Request, "params">, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string") throw new Error(`route parameter "${name}" is not a single value`);
  return value;
}
