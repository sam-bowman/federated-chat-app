import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { OTHER_HEADERS, scriptHash } from "../../scripts/security-headers.mjs";
import { createRequestHandler, envConfigBody, type AssetReader } from "./requestHandler.js";

function fakeReq(url: string): IncomingMessage {
  return { url } as IncomingMessage;
}

function fakeRes() {
  const chunks: Buffer[] = [];
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    writeHead(status: number, headers?: Record<string, string>) {
      res.statusCode = status;
      if (headers) Object.assign(res.headers, headers);
      return res;
    },
    end(body?: string | Buffer) {
      if (body) chunks.push(typeof body === "string" ? Buffer.from(body) : body);
    },
    body() {
      return Buffer.concat(chunks).toString("utf8");
    },
  };
  return res as unknown as ServerResponse & { statusCode: number; headers: Record<string, string>; body(): string };
}

function assetMap(entries: Record<string, string>): AssetReader {
  // TextEncoder allocates a fresh, exactly-sized ArrayBuffer per call -
  // Buffer.from(str).buffer would instead expose Node's shared internal
  // buffer pool for small strings (far more bytes than the string itself).
  const buffers = new Map(Object.entries(entries).map(([k, v]) => [k, new TextEncoder().encode(v).buffer]));
  return (path: string) => buffers.get(path);
}

describe("envConfigBody", () => {
  it("embeds the given API_URL", () => {
    expect(envConfigBody("https://chat.example.com")).toBe(
      'window.__RUNTIME_CONFIG__ = {"API_URL":"https://chat.example.com"};\n'
    );
  });

  it("defaults to an empty string when undefined", () => {
    expect(envConfigBody(undefined)).toBe('window.__RUNTIME_CONFIG__ = {"API_URL":""};\n');
  });
});

describe("createRequestHandler", () => {
  it("serves /env-config.js dynamically with no-store caching, not as an embedded asset", () => {
    const handler = createRequestHandler(assetMap({}), () => "http://localhost:4000");
    const res = fakeRes();
    handler(fakeReq("/env-config.js"), res);

    expect(res.statusCode).toBe(200);
    expect(res.headers["Cache-Control"]).toBe("no-store");
    expect(res.body()).toContain("http://localhost:4000");
  });

  it("serves index.html for the root path", () => {
    const handler = createRequestHandler(assetMap({ "index.html": "<html>root</html>" }));
    const res = fakeRes();
    handler(fakeReq("/"), res);

    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(res.body()).toBe("<html>root</html>");
  });

  it("serves a real embedded asset with the right content type", () => {
    const handler = createRequestHandler(assetMap({ "assets/index-abc123.js": "console.log(1)" }));
    const res = fakeRes();
    handler(fakeReq("/assets/index-abc123.js"), res);

    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("text/javascript; charset=utf-8");
    expect(res.body()).toBe("console.log(1)");
  });

  // Regression-relevant: client-side routing (react-router-dom) needs any
  // unknown path to fall back to index.html, exactly like nginx.conf's
  // `try_files $uri $uri/ /index.html` - otherwise a deep link (e.g.
  // reloading on /friends) would 404 instead of letting the SPA router
  // handle it.
  it("falls back to index.html for an unknown path (SPA routing)", () => {
    const handler = createRequestHandler(assetMap({ "index.html": "<html>root</html>" }));
    const res = fakeRes();
    handler(fakeReq("/friends"), res);

    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(res.body()).toBe("<html>root</html>");
  });

  it("returns 404 when even index.html isn't found", () => {
    const handler = createRequestHandler(assetMap({}));
    const res = fakeRes();
    handler(fakeReq("/anything"), res);

    expect(res.statusCode).toBe(404);
  });

  it("decodes percent-encoded paths before asset lookup", () => {
    const handler = createRequestHandler(assetMap({ "a b.svg": "<svg/>" }));
    const res = fakeRes();
    handler(fakeReq("/a%20b.svg"), res);

    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("image/svg+xml");
  });

  it("defaults to application/octet-stream for an unrecognized extension", () => {
    const handler = createRequestHandler(assetMap({ "file.unknownext": "data" }));
    const res = fakeRes();
    handler(fakeReq("/file.unknownext"), res);

    expect(res.headers["Content-Type"]).toBe("application/octet-stream");
  });
});

// The security headers (#289): the same set the image's nginx sends (#281), on every kind of response, with the policy made from the page
// that is served, on a real HTTP server. (The built binary is run through the image's own checker, .github/scripts/check-client-binary.mjs, in CI.
// That is not imported here: the client's image build only has client/ in it, and type-checks this file.)
const PAGE = `<!doctype html><html><head>
<script>window.appearance = 1;</script>
<script type="module" src="/assets/index-abc.js"></script>
<script src="/env-config.js"></script>
<script>
  window.recover = 2;
</script>
</head><body></body></html>`;

describe("the security headers", () => {
  async function serve(entries: Record<string, string>, run: (base: string) => Promise<void>) {
    const server = createServer(createRequestHandler(assetMap(entries), () => "http://localhost:4000"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await run(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("are on the page, a deep link, a built file, env-config.js and a missing file", async () => {
    await serve({ "index.html": PAGE, "assets/index-abc.js": "console.log(1)" }, async (base) => {
      for (const path of ["/", "/communities/abc/def", "/assets/index-abc.js", "/env-config.js", "/assets/nothing-here.js"]) {
        const res = await fetch(`${base}${path}`);
        expect(res.headers.get("content-security-policy"), path).toContain("script-src 'self'");
        for (const [name, value] of Object.entries(OTHER_HEADERS)) expect(res.headers.get(name), `${path} ${name}`).toBe(value);
      }
    });
  });

  it("send exactly the image's other headers, with the same values", async () => {
    await serve({ "index.html": PAGE }, async (base) => {
      const res = await fetch(`${base}/`);
      for (const [name, value] of Object.entries(OTHER_HEADERS)) expect(res.headers.get(name), name).toBe(value);
      expect(res.headers.get("server")).toBeNull(); // nothing says what is serving
    });
  });

  it("name the page's inline scripts by hash, and no others", async () => {
    await serve({ "index.html": PAGE }, async (base) => {
      const csp = (await fetch(`${base}/`)).headers.get("content-security-policy")!;
      const script = csp.split("; ").find((d) => d.startsWith("script-src "))!;
      expect(script).toContain(scriptHash("window.appearance = 1;"));
      expect(script).toContain(scriptHash("\n  window.recover = 2;\n"));
      expect(script.match(/'sha256-/g)).toHaveLength(2);
      expect(script).not.toMatch(/unsafe-inline|unsafe-eval/);
    });
  });

  it("follow the page: a page with a different script gets a different policy", async () => {
    await serve({ "index.html": "<script>other()</script>" }, async (base) => {
      const csp = (await fetch(`${base}/`)).headers.get("content-security-policy")!;
      expect(csp).toContain(scriptHash("other()"));
      expect(csp).not.toContain(scriptHash("window.appearance = 1;"));
    });
  });

  it("are on a 404 when there is not even a page", () => {
    const res = fakeRes();
    createRequestHandler(assetMap({}))(fakeReq("/anything"), res);
    expect(res.statusCode).toBe(404);
    expect(res.headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(res.headers["Content-Security-Policy"]).toContain("default-src 'self'");
  });

  it("answer a missing file under /assets/ with a 404, not the page, as nginx does", () => {
    const res = fakeRes();
    createRequestHandler(assetMap({ "index.html": PAGE }))(fakeReq("/assets/gone-1234.js"), res);
    expect(res.statusCode).toBe(404);
    expect(res.body()).toBe("Not found");
  });

  it("still serve the page for a deep link whose name merely starts like a built file's", () => {
    const res = fakeRes();
    createRequestHandler(assetMap({ "index.html": PAGE }))(fakeReq("/assets-are-us"), res);
    expect(res.statusCode).toBe(200);
  });
});
