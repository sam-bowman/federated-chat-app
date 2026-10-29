// Run with `node --test .github/scripts/` (the `lint` job in ci.yml does).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OTHER_HEADERS, buildPolicy } from "../../client/scripts/security-headers.mjs";
import { problemsWith } from "./check-client-headers.mjs";

const PAGE = "<script>window.a = 1;</script><script src='/assets/x.js'></script><script>window.b = 2;</script>";

const goodHeaders = (page = PAGE, extra = {}) =>
  new Headers({ "content-security-policy": buildPolicy(page), server: "nginx", ...Object.fromEntries(Object.entries(OTHER_HEADERS).map(([k, v]) => [k.toLowerCase(), v])), ...extra });

describe("checking a response's security headers", () => {
  it("finds nothing wrong with the headers the generator makes", () => {
    assert.deepEqual(problemsWith("page", goodHeaders(), PAGE), []);
    assert.deepEqual(problemsWith("a file", goodHeaders()), []);
  });

  it("notices a header that is missing, and one with another value", () => {
    const headers = goodHeaders();
    headers.delete("x-frame-options");
    headers.set("referrer-policy", "unsafe-url");
    const problems = problemsWith("page", headers);
    assert.equal(problems.length, 2);
    assert.match(problems.join("\n"), /X-Frame-Options/);
    assert.match(problems.join("\n"), /Referrer-Policy/);
  });

  it("notices no policy at all", () => {
    const headers = goodHeaders();
    headers.delete("content-security-policy");
    assert.match(problemsWith("page", headers).join("\n"), /no Content-Security-Policy/);
  });

  it("notices an nginx that says which version it is", () => {
    assert.match(problemsWith("page", goodHeaders(PAGE, { server: "nginx/1.29.8" })).join("\n"), /version/);
  });

  it("notices a script-src that allows any inline script", () => {
    const policy = buildPolicy(PAGE).replace("script-src 'self'", "script-src 'self' 'unsafe-inline'");
    assert.match(problemsWith("page", goodHeaders(PAGE, { "content-security-policy": policy })).join("\n"), /allows/);
  });

  it("notices a page script the policy does not name (the page would not draw), and a hash for one that is not there", () => {
    const changedPage = PAGE.replace("window.b = 2;", "window.b = 3;");
    const problems = problemsWith("page", goodHeaders(PAGE), changedPage).join("\n");
    assert.match(problems, /does not name an inline script/);
    assert.match(problems, /names a script that is not in the page/);
  });

  it("notices a page that has no inline script, because index.html does and something is wrong", () => {
    assert.match(problemsWith("page", goodHeaders("<html></html>"), "<html></html>").join("\n"), /no inline script/);
  });
});
