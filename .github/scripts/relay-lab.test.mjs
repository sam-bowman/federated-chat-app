// The relay lab (e2e/relay-lab, #245) installs Playwright inside a container at run time. That install is pinned by a lockfile (so a dependency
// of it cannot change between two runs, and OpenSSF Scorecard's Pinned-Dependencies sees nothing unpinned), and the browsers in the container
// image are only the right ones for ONE Playwright version. These tests keep the three places that name it in step: the lab's package.json,
// its lockfile and the image tag in its docker-compose.yml. When Dependabot moves one of them, this fails until the others follow.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const lab = new URL("../../e2e/relay-lab/", import.meta.url);
const read = (name) => readFileSync(new URL(name, lab), "utf8");

const pkg = JSON.parse(read("package.json"));
const lock = JSON.parse(read("package-lock.json"));
const compose = read("docker-compose.yml");
const run = read("run.sh");

test("the lab pins Playwright to one exact version, and the lockfile has that version with a hash", () => {
  const wanted = pkg.dependencies?.playwright;
  assert.match(wanted, /^\d+\.\d+\.\d+$/u, "an exact version, not a range");
  const locked = lock.packages["node_modules/playwright"];
  assert.equal(locked.version, wanted);
  assert.match(locked.integrity, /^sha512-/u);
  assert.match(lock.packages["node_modules/playwright-core"].integrity, /^sha512-/u);
});

test("the browser image in docker-compose.yml is the same Playwright version as the package it is used with", () => {
  const image = /mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-/u.exec(compose);
  assert.ok(image, "the lab's browser image is a Playwright image with a version in its tag");
  assert.equal(image[1], pkg.dependencies.playwright, "the image's browsers belong to one Playwright version only");
});

test("run.sh installs from the lockfile and from nothing else", () => {
  assert.match(run, /^npm ci\b/mu);
  for (const command of ["npm i ", "npm install", "npm init", "npx "]) {
    assert.equal(run.includes(command), false, `${command.trim()} would install something the lockfile does not name`);
  }
  assert.match(compose, /package-lock\.json:\/work\/package-lock\.json/u, "the lockfile is what the container sees");
  assert.match(compose, /package\.json:\/work\/package\.json/u);
});
