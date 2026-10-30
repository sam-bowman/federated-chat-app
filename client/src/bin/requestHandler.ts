import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";
import { OTHER_HEADERS, buildPolicy } from "../../scripts/security-headers.mjs";

// Reproduces the two behaviors client/nginx.conf gives the Docker image:
// SPA fallback (any non-asset path serves index.html) and a dynamically
// generated /env-config.js with no-store caching - see
// client/docker-entrypoint.sh and src/api/client.ts for why that file
// exists at all. No disk write needed here, unlike the Docker entrypoint:
// the response is built directly from process.env on each request.
//
// And the same security headers the image's nginx sends (#281, #289), on every response: the Content-Security-Policy is made from the
// page being served, by the one generator the image uses (scripts/security-headers.mjs), so the two can never differ.

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
  // The embedded files do not change while this runs, so the policy (which hashes the page's inline scripts) is made once, on first use.
  let security: Record<string, string> | undefined;
  const securityHeaders = () => {
    if (!security) {
      const page = readAsset("index.html");
      security = { "Content-Security-Policy": buildPolicy(page ? Buffer.from(page).toString("utf8") : ""), ...OTHER_HEADERS };
    }
    return security;
  };

  return function handleRequest(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === "/env-config.js") {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store", ...securityHeaders() });
      res.end(envConfigBody(getApiUrl()));
      return;
    }

    const assetKey = pathname === "/" ? "index.html" : pathname.slice(1);
    let servedKey = assetKey;
    let asset = readAsset(assetKey);

    // A built file that is not there is a 404, not the page, as nginx.conf's `location /assets/` does: the page's own recovery from an
    // upgrade (the build's files vanished) is to see exactly that, and a page served in place of a script would only be a syntax error.
    if (!asset && pathname.startsWith("/assets/")) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...securityHeaders() });
      res.end("Not found");
      return;
    }

    if (!asset) {
      // Client-side routing (react-router-dom) - any path that isn't a
      // real embedded asset falls back to index.html so deep links work.
      servedKey = "index.html";
      asset = readAsset(servedKey);
    }

    if (!asset) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...securityHeaders() });
      res.end("Not found");
      return;
    }

    const contentType = MIME_TYPES[extname(servedKey)] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType, ...securityHeaders() });
    res.end(Buffer.from(asset));
  };
}
