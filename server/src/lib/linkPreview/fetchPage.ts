// Reads the start of a web page for a link preview (#197). The address is a stranger's, so this is the part that must not be talked
// into anything: it only goes to a PUBLIC address (checked on the address the connection really uses, so a name that answers with
// one address for the check and another for the connection cannot get through), only on the ordinary web ports, follows a limited
// number of redirects checking each one again, gives up quickly, reads only the first part of the page, accepts only an HTML page,
// and sends no cookies or credentials. It returns text; it never runs or follows anything in it.
import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { SsrfBlockedError, isPrivateAddress } from "../federation/ssrfGuard.js";

export interface FetchLimits {
  /** The whole fetch, redirects included. */
  timeoutMs: number;
  /** How much of the page is read; the rest is not asked for. */
  maxBytes: number;
  maxRedirects: number;
  userAgent: string;
  /** Tests only: lets the fetch go to a local server. Never set by the server itself. */
  allowPrivate?: boolean;
}

export type FetchFailure = "not_http" | "bad_port" | "blocked" | "too_many_redirects" | "timeout" | "not_html" | "status" | "error";
/** `code` is the system's own short name for what went wrong with a connection (`ENOTFOUND`: the name could not be looked up), when it has one. */
export type FetchResult = { ok: true; finalUrl: string; html: string } | { ok: false; reason: FetchFailure; code?: string };

/** The system error code of a failed connection, only when it is a plain short one: it ends up in a log, so nothing else is passed on. */
export function errorCodeOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{3,40}$/u.test(code) ? code : undefined;
}

/** Only the ordinary web ports: a link cannot be used to feel for other services on a public address. */
function portAllowed(url: URL): boolean {
  return url.port === "" || url.port === "80" || url.port === "443";
}

/** A `lookup` for the connection that refuses any name answering with a non-public address, and hands the connection a checked one. */
export function safeLookup(allowPrivate: boolean): typeof dnsLookup {
  return ((hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    const wantsAll = typeof options === "object" && options !== null && (options as { all?: boolean }).all === true;
    dnsLookup(hostname, { all: true, family: typeof options === "object" && options !== null ? (options as { family?: number }).family : undefined }, (err, addresses) => {
      if (err) return callback(err);
      if (!addresses.length || (!allowPrivate && addresses.some((a) => isPrivateAddress(a.address)))) return callback(new SsrfBlockedError(hostname));
      return wantsAll ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family);
    });
  }) as unknown as typeof dnsLookup;
}

function decode(buffer: Buffer, contentType: string): string {
  const charset = /charset=["']?([\w-]+)/iu.exec(contentType)?.[1]?.toLowerCase();
  try {
    return new TextDecoder(charset && charset !== "utf8" ? charset : "utf-8", { fatal: false }).decode(buffer);
  } catch {
    return buffer.toString("utf8");
  }
}

/** One request, no redirect followed: the answer's status, headers and (for a page) the first bytes. */
function once(url: URL, limits: FetchLimits, deadline: number): Promise<{ status: number; location: string | null; contentType: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(
      url,
      {
        method: "GET",
        lookup: safeLookup(limits.allowPrivate === true),
        agent: false,
        headers: { "User-Agent": limits.userAgent, Accept: "text/html,application/xhtml+xml;q=0.9", "Accept-Encoding": "identity" },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = typeof response.headers.location === "string" ? response.headers.location : null;
        const contentType = String(response.headers["content-type"] ?? "");
        if (status < 200 || status >= 300 || !/^(text\/html|application\/xhtml\+xml)\b/iu.test(contentType)) {
          response.destroy();
          return resolve({ status, location, contentType, body: Buffer.alloc(0) });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          chunks.push(chunk);
          // Enough: the rest of the page is not read, so a huge one costs no more than a small one.
          if (size >= limits.maxBytes) response.destroy();
        });
        const finish = () => resolve({ status, location, contentType, body: Buffer.concat(chunks).subarray(0, limits.maxBytes) });
        response.on("end", finish);
        response.on("close", finish);
        response.on("error", finish);
      }
    );
    const remaining = Math.max(deadline - Date.now(), 1);
    const timer = setTimeout(() => request.destroy(new Error("timeout")), remaining);
    request.on("close", () => clearTimeout(timer));
    request.on("error", reject);
    request.end();
  });
}

/** One request to one address: what `fetchPage` asks for each hop. A test passes its own, to see which addresses are asked for. */
export type Transport = typeof once;

export async function fetchPage(address: string, limits: FetchLimits, transport: Transport = once): Promise<FetchResult> {
  const deadline = Date.now() + limits.timeoutMs;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return { ok: false, reason: "not_http" };
  }
  for (let hops = 0; ; hops++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "not_http" };
    if (!limits.allowPrivate && !portAllowed(url)) return { ok: false, reason: "bad_port" };
    // A literal address never goes through a lookup, so it is checked here.
    const host = url.hostname.replace(/^\[|\]$/gu, "");
    if (!limits.allowPrivate && (host.toLowerCase() === "localhost" || (isIP(host) !== 0 && isPrivateAddress(host)))) return { ok: false, reason: "blocked" };
    let answer;
    try {
      answer = await transport(url, limits, deadline);
    } catch (err) {
      if (err instanceof SsrfBlockedError || (err as { name?: string }).name === "SsrfBlockedError") return { ok: false, reason: "blocked" };
      if ((err as Error).message === "timeout") return { ok: false, reason: "timeout" };
      return { ok: false, reason: "error", code: errorCodeOf(err) };
    }
    if (answer.status >= 300 && answer.status < 400 && answer.location) {
      if (hops >= limits.maxRedirects) return { ok: false, reason: "too_many_redirects" };
      try {
        url = new URL(answer.location, url); // checked again at the top of the loop, like the first address
      } catch {
        return { ok: false, reason: "error" };
      }
      continue;
    }
    if (answer.status < 200 || answer.status >= 300) return { ok: false, reason: "status" };
    if (!/^(text\/html|application\/xhtml\+xml)\b/iu.test(answer.contentType)) return { ok: false, reason: "not_html" };
    return { ok: true, finalUrl: url.href, html: decode(answer.body, answer.contentType) };
  }
}
