// Stops a test run on a Node release known to crash it, with a message that says why (#211).
//
// Node 24.15.0 on Windows kills a process now and then with exit code 3221226505 (0xC0000409, a fast-fail inside libuv, no message) while
// ordinary HTTP traffic is going through it. In the test suites it shows up as "Worker exited unexpectedly" and, worse, as a file whose tests
// are simply missing from the summary: a run that is not green but looks almost so. It reproduces with no Vitest, no database and none of this
// repository's code (a plain Express server and superagent, about one run in four), is gone in 24.14.1 and in every release from 24.16.0, and
// has never been seen on Node 22, which is what CI and the Docker images use.
//
// This repository is built, tested and shipped on Node 22 only (root package.json `engines`, `.nvmrc`), so that is what the message asks for;
// the guard is about this one release, whatever the engines range says, because `npm install` only warns about engines and does not stop.
//
// Run by the `pretest` hooks of the workspaces. `ALLOW_KNOWN_BAD_NODE=1` runs anyway (for someone investigating, or who accepts reruns).
import { pathToFileURL } from "node:url";

/** Releases (and the platform) that crash. Add one only with a reproduction, as above. */
export const KNOWN_BAD = [{ platform: "win32", version: "24.15.0", issue: 211 }];

/** The message to stop with, or null when this Node is fine. `version` is as `process.version` gives it (with a leading v). */
export function knownBadNode(version, platform, env = {}) {
  if (env.ALLOW_KNOWN_BAD_NODE === "1") return null;
  const bare = String(version).replace(/^v/u, "");
  const bad = KNOWN_BAD.find((b) => b.platform === platform && b.version === bare);
  if (!bad) return null;
  return [
    `Node ${bare} on Windows crashes test runs at random (exit code 3221226505, a worker or a whole file lost): see issue #${bad.issue}.`,
    "It is a bug in that Node release, not in this code. Use Node 22, which is what CI and the Docker images use and what this repository asks for (.nvmrc says 22), and run the tests again.",
    "To run anyway and rerun what crashes, set ALLOW_KNOWN_BAD_NODE=1.",
  ].join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const message = knownBadNode(process.version, process.platform, process.env);
  if (message) {
    console.error(message);
    process.exit(1);
  }
}
