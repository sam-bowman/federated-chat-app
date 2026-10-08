import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
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
