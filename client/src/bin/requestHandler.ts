import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";

// Reproduces the two behaviors client/nginx.conf gives the Docker image:
// SPA fallback (any non-asset path serves index.html) and a dynamically
// generated /env-config.js with no-store caching - see
// client/docker-entrypoint.sh and src/api/client.ts for why that file
// exists at all. No disk write needed here, unlike the Docker entrypoint:
// the response is built directly from process.env on each request.

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** Looks up an embedded asset by its path relative to the dist/ root (no leading slash). Returns undefined if not found. */
export type AssetReader = (path: string) => ArrayBufferLike | undefined;

export function envConfigBody(apiUrl: string | undefined): string {
  return `window.__RUNTIME_CONFIG__ = ${JSON.stringify({ API_URL: apiUrl ?? "" })};\n`;
}

export function createRequestHandler(readAsset: AssetReader, getApiUrl: () => string | undefined = () => process.env.API_URL) {
  return function handleRequest(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === "/env-config.js") {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
      res.end(envConfigBody(getApiUrl()));
      return;
    }

    const assetKey = pathname === "/" ? "index.html" : pathname.slice(1);
    let servedKey = assetKey;
    let asset = readAsset(assetKey);

    if (!asset) {
      // Client-side routing (react-router-dom) - any path that isn't a
      // real embedded asset falls back to index.html so deep links work.
      servedKey = "index.html";
      asset = readAsset(servedKey);
    }

    if (!asset) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const contentType = MIME_TYPES[extname(servedKey)] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(Buffer.from(asset));
  };
}
