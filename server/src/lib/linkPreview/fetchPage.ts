// Reads the start of a web page for a link preview (#197). The address is a stranger's, so this is the part that must not be talked
// into anything: it only goes to a PUBLIC address (checked on the address the connection really uses, so a name that answers with
// one address for the check and another for the connection cannot get through), only on the ordinary web ports, follows a limited
// number of redirects checking each one again, gives up quickly, reads only the first part of the page, accepts only an HTML page,
// and sends no cookies or credentials. It returns text; it never runs or follows anything in it.
// The same rules fetch a picture (`fetchImage`, #244): only the kind of thing asked for, and the size allowed, differ.
import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { SsrfBlockedError, isPrivateAddress } from "../federation/ssrfGuard.js";

/** What a request asks for and accepts back: a web page, or a picture. */
export type FetchKind = "html" | "image";

const KINDS: Record<FetchKind, { accept: string; contentType: RegExp }> = {
  html: { accept: "text/html,application/xhtml+xml;q=0.9", contentType: /^(text\/html|application\/xhtml\+xml)\b/iu },
  // What the other site SAYS it is only decides whether to read on: the bytes are looked at afterwards (lib/linkPreview/imageInfo.ts).
  image: { accept: "image/png,image/jpeg,image/gif,image/webp", contentType: /^image\/(png|jpe?g|pjpeg|gif|webp)\b/iu },
};

export interface FetchLimits {
  /** The whole fetch, redirects included. */
  timeoutMs: number;
  /** How much of the page is read; the rest is not asked for. For a picture it is the most a picture may be: one more byte is read, to know it was more. */
  maxBytes: number;
  maxRedirects: number;
  userAgent: string;
  /** What is being fetched. A page unless said otherwise. */
  kind?: FetchKind;
  /** Tests only: lets the fetch go to a local server. Never set by the server itself. */
  allowPrivate?: boolean;
}

export type FetchFailure = "not_http" | "bad_port" | "blocked" | "too_many_redirects" | "timeout" | "not_html" | "not_image" | "too_large" | "status" | "error";
/**
 * `code` is the system's own short name for what went wrong with a connection (`ENOTFOUND`: the name could not be looked up), when it has one.
 * `contentType` is what the other site said the thing was, when it was not what was asked for (a link that is itself a picture says so here).
 */
export type FetchFailed = { ok: false; reason: FetchFailure; code?: string; contentType?: string };
export type FetchResult = { ok: true; finalUrl: string; html: string } | FetchFailed;
export type FetchImageResult = { ok: true; finalUrl: string; bytes: Buffer; contentType: string } | FetchFailed;

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
  const wanted = KINDS[limits.kind ?? "html"];
  // A picture is read one byte past what is allowed, so "exactly the limit" and "more than the limit" can be told apart.
  const cap = limits.kind === "image" ? limits.maxBytes + 1 : limits.maxBytes;
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(
      url,
      {
        method: "GET",
        lookup: safeLookup(limits.allowPrivate === true),
        agent: false,
        headers: { "User-Agent": limits.userAgent, Accept: wanted.accept, "Accept-Encoding": "identity" },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = typeof response.headers.location === "string" ? response.headers.location : null;
        const contentType = String(response.headers["content-type"] ?? "");
        if (status < 200 || status >= 300 || !wanted.contentType.test(contentType)) {
          response.destroy();
          return resolve({ status, location, contentType, body: Buffer.alloc(0) });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          chunks.push(chunk);
          // Enough: the rest of the page is not read, so a huge one costs no more than a small one.
          if (size >= cap) response.destroy();
        });
        const finish = () => resolve({ status, location, contentType, body: Buffer.concat(chunks).subarray(0, cap) });
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

/** What every hop of a fetch has to pass, and what the last one gave. The loop is the same for a page and a picture. */
async function follow(address: string, limits: FetchLimits, transport: Transport): Promise<{ ok: true; finalUrl: string; contentType: string; body: Buffer } | FetchFailed> {
  const kind = limits.kind ?? "html";
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
    if (!KINDS[kind].contentType.test(answer.contentType)) return { ok: false, reason: kind === "image" ? "not_image" : "not_html", contentType: answer.contentType };
    return { ok: true, finalUrl: url.href, contentType: answer.contentType, body: answer.body };
  }
}

export async function fetchPage(address: string, limits: FetchLimits, transport: Transport = once): Promise<FetchResult> {
  const got = await follow(address, { ...limits, kind: "html" }, transport);
  return got.ok ? { ok: true, finalUrl: got.finalUrl, html: decode(got.body, got.contentType) } : got;
}

/**
 * A picture, with every rule a page has (public addresses only, every redirect checked, the time and the size limited). The bytes come back as
 * they are: whether they really are a picture, and a small enough one, is decided by checkImage and not by what the site said.
 * `too_large` is when there was more than `maxBytes`.
 */
export async function fetchImage(address: string, limits: FetchLimits, transport: Transport = once): Promise<FetchImageResult> {
  const got = await follow(address, { ...limits, kind: "image" }, transport);
  if (!got.ok) return got;
  if (got.body.length > limits.maxBytes) return { ok: false, reason: "too_large" };
  return { ok: true, finalUrl: got.finalUrl, bytes: got.body, contentType: got.contentType };
}
