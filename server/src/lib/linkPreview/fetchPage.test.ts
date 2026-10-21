// Reading a page for a preview is the part that must not be talked into anything, so each limit has a test that fails without it.
// The real network code is run against a small server on this machine (which the guard would normally refuse: `allowPrivate`
// is the test's way in), and the guard itself is run for real against addresses it must refuse.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchPage, safeLookup, type FetchLimits, type Transport } from "./fetchPage.js";

const LIMITS: FetchLimits = { timeoutMs: 1500, maxBytes: 20_000, maxRedirects: 3, userAgent: "TestAgent/1.0 (+https://chat.example)", allowPrivate: true };
const HTML = `<html><head><title>Hello</title></head><body>hi</body></html>`;

let server: http.Server;
let base: string;
const seen: http.IncomingMessage[] = [];
let bytesSent = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push(req);
    const path = req.url ?? "/";
    if (path === "/ok") return void res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(HTML);
    if (path === "/latin1") return void res.writeHead(200, { "Content-Type": "text/html; charset=iso-8859-1" }).end(Buffer.from("<title>caf\xe9</title>", "latin1"));
    if (path === "/xhtml") return void res.writeHead(200, { "Content-Type": "application/xhtml+xml" }).end(HTML);
    if (path === "/json") return void res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    if (path === "/image") return void res.writeHead(200, { "Content-Type": "image/png" }).end(Buffer.alloc(100));
    if (path === "/missing") return void res.writeHead(404, { "Content-Type": "text/html" }).end("nope");
    if (path === "/error") return void res.writeHead(500, { "Content-Type": "text/html" }).end("boom");
    if (path === "/hang") return; // never answers
    if (path === "/slow-body") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.write("<title>start</title>");
      return; // and never finishes
    }
    if (path === "/huge") {
      res.writeHead(200, { "Content-Type": "text/html" });
      const chunk = Buffer.alloc(8192, "a");
      const timer = setInterval(() => {
        bytesSent += chunk.length;
        if (!res.write(chunk) || bytesSent > 50_000_000) clearInterval(timer);
      }, 0);
      res.on("close", () => clearInterval(timer));
      return;
    }
    if (path === "/redirect") return void res.writeHead(302, { Location: "/ok" }).end();
    if (path === "/redirect-absolute") return void res.writeHead(301, { Location: `${base}/ok` }).end();
    if (path === "/loop") return void res.writeHead(302, { Location: "/loop" }).end();
    if (path === "/chain") return void res.writeHead(302, { Location: "/redirect" }).end();
    if (path === "/redirect-to-file") return void res.writeHead(302, { Location: "file:///etc/passwd" }).end();
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("reading a page", () => {
  it("gets the HTML of a page, and says where it ended up", async () => {
    const result = await fetchPage(`${base}/ok`, LIMITS);
    expect(result).toEqual({ ok: true, finalUrl: `${base}/ok`, html: HTML });
  });

  it("accepts an XHTML page, and reads the character set the page says", async () => {
    expect((await fetchPage(`${base}/xhtml`, LIMITS)).ok).toBe(true);
    const latin = await fetchPage(`${base}/latin1`, LIMITS);
    expect(latin.ok && latin.html).toContain("café");
  });

  it("sends no cookies or credentials, a clear User-Agent, asks for no compression, and only ever GETs", async () => {
    seen.length = 0;
    await fetchPage(`${base}/ok`, LIMITS);
    const request = seen[0];
    expect(request.method).toBe("GET");
    expect(request.headers["user-agent"]).toBe(LIMITS.userAgent);
    expect(request.headers["accept-encoding"]).toBe("identity");
    for (const header of ["cookie", "authorization", "referer", "origin"]) expect(request.headers[header], header).toBeUndefined();
  });

  it("is not an HTML page: JSON, an image", async () => {
    expect(await fetchPage(`${base}/json`, LIMITS)).toEqual({ ok: false, reason: "not_html" });
    expect(await fetchPage(`${base}/image`, LIMITS)).toEqual({ ok: false, reason: "not_html" });
  });

  it("is an error or missing page", async () => {
    expect(await fetchPage(`${base}/missing`, LIMITS)).toEqual({ ok: false, reason: "status" });
    expect(await fetchPage(`${base}/error`, LIMITS)).toEqual({ ok: false, reason: "status" });
  });

  it("gives up on a server that never answers, and on one that never finishes", async () => {
    const started = Date.now();
    expect(await fetchPage(`${base}/hang`, { ...LIMITS, timeoutMs: 300 })).toEqual({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(1500);
    const slow = await fetchPage(`${base}/slow-body`, { ...LIMITS, timeoutMs: 300 });
    // What arrived by then is what is read: the page may have said enough, but a server that never finishes is not waited for.
    expect(Date.now() - started).toBeLessThan(2500);
    expect(slow.ok || slow.reason === "timeout").toBe(true);
  });

  it("reads only the first part of a page, however big it is, and stops asking for the rest", async () => {
    bytesSent = 0;
    const result = await fetchPage(`${base}/huge`, { ...LIMITS, maxBytes: 20_000, timeoutMs: 3000 });
    expect(result.ok && result.html.length).toBeLessThanOrEqual(20_000);
    expect(result.ok && result.html.length).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(bytesSent, "the connection was closed, not read to the end").toBeLessThan(5_000_000);
  });
});

describe("redirects", () => {
  it("are followed, relative or absolute, a few of them", async () => {
    expect(await fetchPage(`${base}/redirect`, LIMITS)).toEqual({ ok: true, finalUrl: `${base}/ok`, html: HTML });
    expect((await fetchPage(`${base}/redirect-absolute`, LIMITS)).ok).toBe(true);
    expect((await fetchPage(`${base}/chain`, LIMITS)).ok).toBe(true); // two hops
  });

  it("stop at the limit, so a loop is not followed for ever", async () => {
    expect(await fetchPage(`${base}/loop`, LIMITS)).toEqual({ ok: false, reason: "too_many_redirects" });
    expect(await fetchPage(`${base}/chain`, { ...LIMITS, maxRedirects: 1 })).toEqual({ ok: false, reason: "too_many_redirects" });
  });

  it("do not leave http and https for another scheme", async () => {
    expect(await fetchPage(`${base}/redirect-to-file`, LIMITS)).toEqual({ ok: false, reason: "not_http" });
  });

  it("are each checked again like the first address, before it is asked for", async () => {
    const asked: string[] = [];
    const transport: Transport = async (url) => {
      asked.push(url.href);
      return { status: 302, location: "http://10.0.0.5/admin", contentType: "", body: Buffer.alloc(0) };
    };
    const strict: FetchLimits = { ...LIMITS, allowPrivate: false };
    expect(await fetchPage("https://example.com/", strict, transport)).toEqual({ ok: false, reason: "blocked" });
    expect(asked, "the private address was never asked for").toEqual(["https://example.com/"]);

    for (const target of ["http://127.0.0.1/", "http://localhost/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/", "http://[::ffff:10.0.0.1]/", "https://example.com:8080/", "http://192.168.1.1/"]) {
      asked.length = 0;
      const toTarget: Transport = async (url) => {
        asked.push(url.href);
        return { status: 302, location: target, contentType: "", body: Buffer.alloc(0) };
      };
      const result = await fetchPage("https://example.com/", strict, toTarget);
      expect(result.ok, target).toBe(false);
      expect(asked, `${target} was not asked for`).toHaveLength(1);
    }
  });
});

describe("where it will not go", () => {
  const strict: FetchLimits = { ...LIMITS, allowPrivate: false };

  it("refuses a private, loopback or link-local address written out, without making a request", async () => {
    seen.length = 0;
    expect((await fetchPage(`${base}/ok`, strict)).ok, "the local test server").toBe(false);
    for (const address of ["http://127.0.0.1/", "http://localhost/", "http://[::1]/", "http://10.1.2.3/", "http://169.254.169.254/", "http://192.168.0.1/", "http://[fd00::1]/", "http://0.0.0.0/"]) {
      expect(await fetchPage(address, strict), address).toEqual({ ok: false, reason: "blocked" });
    }
    expect(seen).toHaveLength(0);
  });

  it("refuses a port that is not an ordinary web port", async () => {
    for (const address of ["https://example.com:22/", "http://example.com:6379/", "https://example.com:8443/"]) {
      expect(await fetchPage(address, strict), address).toEqual({ ok: false, reason: "bad_port" });
    }
  });

  it("is not about http and https at all for anything else", async () => {
    for (const address of ["ftp://example.com/", "file:///etc/passwd", "gopher://example.com/", "not an address"]) {
      expect((await fetchPage(address, strict)).ok, address).toBe(false);
    }
  });

  it("refuses a NAME that answers with a private address, which is what a name pointing at an internal machine does", async () => {
    const lookup = safeLookup(false);
    const answer = await new Promise<{ error: Error | null }>((resolve) => (lookup as unknown as (h: string, o: object, cb: (e: Error | null) => void) => void)("localhost", {}, (error) => resolve({ error })));
    expect(answer.error?.name).toBe("SsrfBlockedError");
    // And with allowPrivate (tests only) it is let through, so the refusal above is the guard and not the name.
    const open = safeLookup(true);
    const through = await new Promise<{ error: Error | null }>((resolve) => (open as unknown as (h: string, o: object, cb: (e: Error | null) => void) => void)("localhost", {}, (error) => resolve({ error })));
    expect(through.error).toBeNull();
  });

  it("checks every address a name has, not only the first (the same rule federation uses)", async () => {
    // localhost has both 127.0.0.1 and ::1 on most machines; one private address among them is enough to refuse.
    const lookup = safeLookup(false);
    const answer = await new Promise<{ error: Error | null }>((resolve) => (lookup as unknown as (h: string, o: object, cb: (e: Error | null) => void) => void)("localhost", { all: true }, (error) => resolve({ error })));
    expect(answer.error?.name).toBe("SsrfBlockedError");
  });
});
