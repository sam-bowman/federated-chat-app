// Prepares the throwaway server for the ZAP API scan (#250): makes a few people and things through the real API, and writes a copy of
// the OpenAPI file in which every path parameter has a REAL id as its example. Without this ZAP fills `{id}` with the word "id", every
// operation with a path parameter is answered 400 (not an id), and the scan never reaches the code behind it.
//
//   node zap-seed.mjs <server-url> <openapi-in> <openapi-out> <seed-out.json>
//
// Anything that cannot be made is skipped: that operation keeps ZAP's own value. Used by dast.sh; never point it at a real server.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Which seeded id belongs to a path parameter, by the first segment of the path and the parameter's name. */
export function exampleFor(segment, name, ids) {
  const table = {
    communities: { id: ids.community, channelId: ids.channel, roleId: ids.role, inviteId: ids.invite, userId: ids.otherId },
    channels: { id: ids.channel },
    conversations: { id: ids.conversation, emoji: "👍" },
    messages: { id: ids.message, emoji: "👍" },
    users: { id: ids.otherId, username: ids.otherUsername },
    friends: { userId: ids.otherId },
  };
  return table[segment]?.[name];
}

/** The OpenAPI text with `example: "<id>"` added to each path parameter that has a seeded id. A line-by-line edit, to keep the file as it was. */
export function withExamples(spec, ids) {
  let segment = null;
  return spec
    .split("\n")
    .map((line) => {
      const path = line.match(/^ {2}"?(\/[^":]*)"?:\s*$/);
      if (path) {
        segment = path[1].split("/")[1] ?? null;
        return line;
      }
      const param = line.match(/\{ name: (\w+), in: path/);
      if (!param || !segment) return line;
      const value = exampleFor(segment, param[1], ids);
      if (!value || /example:/.test(line)) return line;
      return line.replace(/\s*\}\s*$/, `, example: ${JSON.stringify(value)} }`);
    })
    .join("\n");
}

async function main() {
  const [base, specIn, specOut, seedOut] = process.argv.slice(2);
  if (!base || !specIn || !specOut || !seedOut) throw new Error("usage: zap-seed.mjs <server-url> <openapi-in> <openapi-out> <seed-out.json>");
  const password = process.env.DAST_PASSWORD;
  if (!password) throw new Error("set DAST_PASSWORD");

  const call = async (method, path, token, body) => {
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, json };
  };
  const attempt = async (label, fn) => {
    try {
      return await fn();
    } catch (err) {
      console.error(`seed: ${label} failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  };

  const person = await call("POST", "/auth/register", null, { username: "dast_person", password });
  const other = await call("POST", "/auth/register", null, { username: "dast_other", password });
  const token = person.json?.accessToken;
  if (!token) throw new Error(`could not sign in the test person (status ${person.status})`);

  const ids = { otherId: other.json?.user?.id, otherUsername: "dast_other" };
  const community = await attempt("community", async () => (await call("POST", "/communities", token, { name: "Dast Club" })).json?.community);
  ids.community = community?.id;
  ids.channel = community?.channels?.[0]?.id;
  if (ids.community) {
    ids.role = (await attempt("role", async () => (await call("POST", `/communities/${ids.community}/roles`, token, { name: "Dast role", permissions: "1" })).json))?.role?.id;
    const invite = await attempt("invite", async () => (await call("POST", `/communities/${ids.community}/invites`, token, {})).json);
    ids.invite = invite?.invite?.id ?? invite?.id;
  }
  const conversation = await attempt("conversation", async () => (await call("POST", "/conversations", token, { type: "DM", memberUsernames: ["dast_other"] })).json);
  ids.conversation = conversation?.conversation?.id ?? conversation?.id;
  if (ids.channel) {
    const message = await attempt("message", async () => (await call("POST", `/channels/${ids.channel}/messages`, token, { content: "hello from the scan" })).json);
    ids.message = message?.message?.id ?? message?.id;
  }

  writeFileSync(specOut, withExamples(readFileSync(specIn, "utf8"), ids));
  writeFileSync(seedOut, JSON.stringify({ token, ids }));
  console.error(`seed: ${Object.entries(ids).filter(([, v]) => v).map(([k]) => k).join(", ")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
