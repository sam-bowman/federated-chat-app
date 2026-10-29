// Run with `node --test client/scripts/` (the `lint` job in ci.yml does).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { OTHER_HEADERS, buildPolicy, headersConf, inlineScripts, scriptHash } from "./security-headers.mjs";

const PAGE = `<!doctype html><html><head>
<script>window.a = 1;</script>
<script type="module" src="/assets/index-abc.js"></script>
<script src='/env-config.js'></script>
<script>
  window.b = "two";
</script>
</head><body></body></html>`;

describe("finding the scripts a page runs from itself", () => {
  it("returns the inline ones, whitespace and all, and not the ones with a src", () => {
    assert.deepEqual(inlineScripts(PAGE), ["window.a = 1;", '\n  window.b = "two";\n']);
  });

  it("finds a script whose end tag has a space or attributes in it, which a browser still ends it at", () => {
    assert.deepEqual(inlineScripts("<script>a()</script >"), ["a()"]);
    assert.deepEqual(inlineScripts("<script>a()</script foo=bar>"), ["a()"]);
    assert.deepEqual(inlineScripts("<SCRIPT>a()</SCRIPT>"), ["a()"]);
  });

  it("finds none in a page that has none", () => {
    assert.deepEqual(inlineScripts('<script src="/a.js"></script>'), []);
  });

  it("is not fooled by a `src` that is only text inside a script", () => {
    assert.deepEqual(inlineScripts('<script>var s = "src=1";</script>'), ['var s = "src=1";']);
  });
});

describe("line endings", () => {
  it("are made LF before a script is hashed, as the browser does, so a page built from Windows files gets the hashes the browser computes", () => {
    const lf = "<script>\n  window.a = 1;\n  window.b = 2;\n</script>";
    const crlf = lf.replace(/\n/g, "\r\n");
    const lone = lf.replace(/\n/g, "\r");
    assert.deepEqual(inlineScripts(crlf), inlineScripts(lf));
    assert.deepEqual(inlineScripts(lone), inlineScripts(lf));
    assert.equal(buildPolicy(crlf), buildPolicy(lf));
    assert.ok(!inlineScripts(crlf)[0].includes("\r"));
  });
});

describe("hashing", () => {
  it("is the base64 SHA-256 of the exact text, in the form a policy takes", () => {
    const expected = createHash("sha256").update("window.a = 1;", "utf8").digest("base64");
    assert.equal(scriptHash("window.a = 1;"), `'sha256-${expected}'`);
  });

  it("changes when a single character of the script does", () => {
    assert.notEqual(scriptHash("window.a = 1;"), scriptHash("window.a = 2;"));
    assert.notEqual(scriptHash("x"), scriptHash("x "));
  });
});

describe("the policy", () => {
  const policy = buildPolicy(PAGE);
  const directive = (name) => policy.split("; ").find((d) => d.startsWith(`${name} `));

  it("allows this origin's scripts and the page's own by hash, and nothing else", () => {
    const script = directive("script-src");
    assert.ok(script.startsWith("script-src 'self' "));
    for (const body of inlineScripts(PAGE)) assert.ok(script.includes(scriptHash(body)), "every inline script is named");
    assert.ok(!script.includes("unsafe-inline"));
    assert.ok(!script.includes("unsafe-eval"));
    assert.ok(!/\bhttps?:|\*/.test(script), "no other origin may supply a script");
  });

  it("forbids being framed, plug-ins, a changed base address and forms sent elsewhere", () => {
    assert.equal(directive("frame-ancestors"), "frame-ancestors 'none'");
    assert.equal(directive("object-src"), "object-src 'none'");
    assert.equal(directive("base-uri"), "base-uri 'self'");
    assert.equal(directive("form-action"), "form-action 'self'");
    assert.equal(directive("frame-src"), "frame-src 'none'");
  });

  it("lets the client reach any server it is pointed at, and show their pictures, because it can be pointed at any", () => {
    assert.ok(directive("connect-src").includes("wss:") && directive("connect-src").includes("https:"));
    assert.ok(directive("img-src").includes("https:") && directive("img-src").includes("blob:") && directive("img-src").includes("data:"));
  });

  it("has a script-src with no hash at all for a page with no inline script, instead of a stray space", () => {
    assert.equal(buildPolicy("<html></html>").split("; ").find((d) => d.startsWith("script-src")), "script-src 'self'");
  });
});

describe("the nginx file", () => {
  const conf = headersConf(PAGE);

  it("has one add_header line per header, each `always`, with the policy and every other header", () => {
    const lines = conf.split("\n").filter((l) => l.startsWith("add_header"));
    assert.equal(lines.length, 1 + Object.keys(OTHER_HEADERS).length);
    assert.ok(lines.every((l) => l.endsWith('" always;')));
    assert.ok(lines.some((l) => l.startsWith("add_header Content-Security-Policy ")));
    for (const name of Object.keys(OTHER_HEADERS)) assert.ok(lines.some((l) => l.startsWith(`add_header ${name} `)), name);
  });

  it("asks for the microphone for itself only, and for nothing else the client does not use", () => {
    assert.match(conf, /Permissions-Policy "microphone=\(self\), camera=\(\)/);
  });

  it("cannot put a double quote into a directive, which would end the value early", () => {
    for (const line of conf.split("\n").filter((l) => l.startsWith("add_header"))) {
      assert.equal(line.split('"').length, 3, line);
    }
  });
});

describe("the real index.html", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

  it("has exactly the two inline scripts the policy has to name, and a hash for each", () => {
    const scripts = inlineScripts(html);
    assert.equal(scripts.length, 2, "a new inline script in index.html needs a decision: it is allowed by hash from now on");
    const policy = buildPolicy(html);
    for (const body of scripts) assert.ok(policy.includes(scriptHash(body)));
  });
});
