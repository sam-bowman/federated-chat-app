// Run with `node --test .github/scripts/`. The client image's HEALTHCHECK must ask the address nginx listens on.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const dockerfile = read("client/Dockerfile");
const nginx = read("client/nginx.conf");
// A continued line is one instruction.
const healthcheck = dockerfile.replace(/\\\r?\n/g, " ").split(/\r?\n/).find((line) => line.startsWith("HEALTHCHECK"));
const listens = [...nginx.matchAll(/^\s*listen\s+([^;]+);/gm)].map((m) => m[1].trim());

describe("the client image's healthcheck", () => {
  it("exists and asks the port nginx listens on", () => {
    assert.ok(healthcheck, "the Dockerfile has no HEALTHCHECK");
    const port = healthcheck.match(/:(\d+)\//)?.[1];
    assert.ok(port, `no port in: ${healthcheck}`);
    assert.ok(listens.some((l) => l.endsWith(port) || l === port), `nginx does not listen on ${port} (it listens on: ${listens.join(", ")})`);
  });

  it("does not use `localhost` while nginx listens on IPv4 only: it resolves to ::1 first, where nothing answers", () => {
    const ipv6 = listens.some((l) => l.startsWith("["));
    if (!ipv6) assert.ok(!/\blocalhost\b/.test(healthcheck), `nginx listens on IPv4 only (${listens.join(", ")}) but the healthcheck asks localhost: ${healthcheck}`);
  });
});
