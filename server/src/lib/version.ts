import { readFileSync } from "node:fs";
import { join } from "node:path";

// Replaced at build time by the native-binary build (scripts/build-binary.mjs),
// where there is no package.json next to the executable to read. Undeclared
// everywhere else, which `typeof` handles safely.
declare const __APP_VERSION__: string | undefined;

/** The `version` in `<dir>/package.json`, or null if it can't be read. */
export function readPackageVersion(dir: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const version = (parsed as { version?: unknown } | null)?.version;
    return typeof version === "string" && version ? version : null;
  } catch {
    return null;
  }
}

/**
 * The release this server is running, as advertised in the discovery document so
 * clients can show it. Docker copies `server/package.json` to `/app`, `npm run dev`
 * runs from `server/`, and a packaged binary has it baked in. "unknown" is the
 * honest answer if none of those apply - never a guess.
 */
export const serverVersion: string =
  typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : (readPackageVersion(process.cwd()) ?? "unknown");
