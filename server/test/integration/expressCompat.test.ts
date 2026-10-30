import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { authHeader, registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterAll(disconnectDb);

// Things Express 5 does differently from Express 4 (#276) that this server's handlers were written against. Each one was found by
// running the whole suite on Express 5, and each would be easy to lose again without a test saying what it is.
describe("what Express 5 changed, and what the server does about it", () => {
  it("a request with no body at all reaches its handler as an empty body, not as `undefined`", async () => {
    // Express 5 leaves `req.body` undefined then, and the schema of `PATCH /users/me` (an object with every field optional) refused undefined as
    // a bad request, where Express 4 gave it `{}` and the request changed nothing and answered 200.
    const alice = await registerUser("alice");

    const res = await api.patch("/api/v1/users/me").set(authHeader(alice.accessToken));

    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe("alice");
  });

  it("the query string is read the simple way: `a[]=1` is a key called `a[]`, not a list", () => {
    // The `extended` parser of Express 4 turned nested-looking keys into objects and arrays, which handlers then had to guard against; the
    // simple one (Express 5's default) only makes a list of a key that is repeated. Nothing here sends nested keys; keep it that way.
    expect(app.get("query parser")).toBe("simple");
  });
});
