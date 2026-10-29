// Checks the security headers of a running client image (#281): every kind of response has them, the nginx version is not given away, and the
// Content-Security-Policy names the SAME inline scripts the served page has, by hash. The last one is the point: a policy that names a
// script that is not there, or misses one that is, blocks the page from drawing at all, and nothing but a browser would notice.
//
//   node .github/scripts/check-client-headers.mjs http://localhost:8080
import { pathToFileURL } from "node:url";
import { OTHER_HEADERS, inlineScripts, scriptHash } from "../../client/scripts/security-headers.mjs";

/** What is wrong with one response's headers (an empty list when nothing is). `html` is the page body, for the response that is the page. */
export function problemsWith(where, headers, html) {
  const problems = [];
  const csp = headers.get("content-security-policy");
  if (!csp) problems.push(`${where}: no Content-Security-Policy`);
  for (const [name, value] of Object.entries(OTHER_HEADERS)) {
    if (headers.get(name.toLowerCase()) !== value) problems.push(`${where}: ${name} is "${headers.get(name.toLowerCase())}", expected "${value}"`);
  }
  if (/\d/.test(headers.get("server") ?? "")) problems.push(`${where}: the Server header gives a version: ${headers.get("server")}`);
  if (csp) {
    const script = csp.split("; ").find((d) => d.startsWith("script-src ")) ?? "";
    if (/unsafe-inline|unsafe-eval/.test(script)) problems.push(`${where}: script-src allows ${script}`);
    if (html !== undefined) {
      const wanted = inlineScripts(html).map(scriptHash);
      for (const hash of wanted) if (!script.includes(hash)) problems.push(`${where}: the policy does not name an inline script of the page (${hash})`);
      const named = script.match(/'sha256-[^']+'/g) ?? [];
      for (const hash of named) if (!wanted.includes(hash)) problems.push(`${where}: the policy names a script that is not in the page (${hash})`);
      if (wanted.length === 0) problems.push(`${where}: the page has no inline script at all, which is not what index.html has`);
    }
  }
  return problems;
}

async function main() {
  const base = process.argv[2];
  if (!base) throw new Error("usage: check-client-headers.mjs <client url>");
  const get = (path) => fetch(new URL(path, base));
  const page = await get("/");
  const html = await page.text();
  const asset = html.match(/(?:src|href)="(\/assets\/[^"]+\.js)"/)?.[1];
  if (!asset) throw new Error("the page names no script under /assets/");

  const problems = [...problemsWith("/ (the page)", page.headers, html)];
  for (const [label, path] of [
    ["a deep link", "/communities/abc/def"],
    [`a built file (${asset})`, asset],
    ["env-config.js", "/env-config.js"],
    ["a missing file under /assets/", "/assets/nothing-here.js"],
  ]) {
    const response = await get(path);
    problems.push(...problemsWith(label, response.headers));
  }
  const missing = await get("/assets/nothing-here.js");
  if (missing.status !== 404) problems.push(`a missing file under /assets/ answered ${missing.status}, not 404`);

  if (problems.length) {
    for (const problem of problems) console.error(`::error::${problem}`);
    process.exit(1);
  }
  console.log("The client sends every security header on every kind of response, and the policy names exactly the page's inline scripts.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
