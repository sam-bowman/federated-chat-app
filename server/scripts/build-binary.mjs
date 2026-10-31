// Packages the already-built server/dist/ into a single native executable
// for the current platform, via Node's Single Executable Applications:
// https://nodejs.org/api/single-executable-applications.html
//
// Unlike the client (client/scripts/build-binary.mjs), every dependency's JS
// is fully bundled in (not external) - SEA can't require() an external
// package by bare specifier, only actual Node builtins resolve that way
// (confirmed empirically: an external @prisma/client require failed with
// ERR_UNKNOWN_BUILTIN_MODULE). Since Prisma 7 that is everything: the client
// is JavaScript over the pg driver (its query compiler is a WebAssembly
// module carried inside @prisma/client as text), so there is no native query
// engine to ship beside the executable any more. What does ship beside it is
// prisma/migrations/ (needed by src/standaloneMigrate.ts).
//
// Run `npm run build` first (produces dist/) - this script doesn't do that
// itself, so `npm run build:binary` chains both.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { inject } from "postject";

const serverRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(serverRoot, "dist-bin");
const packageVersion = JSON.parse(readFileSync(join(serverRoot, "package.json"), "utf8")).version;
const sentinelFuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function platformBinaryName() {
  const archSuffix = process.arch === "x64" ? "x64" : process.arch;
  if (process.platform === "win32") return `my-chat-server-win32-${archSuffix}.exe`;
  if (process.platform === "darwin") return `my-chat-server-darwin-${archSuffix}`;
  return `my-chat-server-linux-${archSuffix}`;
}

async function main() {
  const distEntry = join(serverRoot, "dist/binaryEntry.js");
  if (!existsSync(distEntry)) {
    throw new Error(`${distEntry} doesn't exist - run \`npm run build\` first.`);
  }

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const bundlePath = join(outDir, "server.bundle.cjs");
  await esbuild.build({
    entryPoints: [distEntry],
    outfile: bundlePath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    // No package.json sits next to the executable, so bake the version in (see src/lib/version.ts).
    //
    // The generated Prisma client (ES module source) sets a `__dirname` global from `import.meta.url`, which a CommonJS bundle does not have
    // (it threw at start-up: fileURLToPath(undefined)). It is only a directory for files the client could look for beside itself, and there
    // are none: so it is the executable's own location.
    define: { __APP_VERSION__: JSON.stringify(packageVersion), "import.meta.url": "__importMetaUrl" },
    banner: { js: 'const __importMetaUrl = require("node:url").pathToFileURL(process.execPath).href;' },
  });

  const blobPath = join(outDir, "sea-prep.blob");
  const seaConfigPath = join(outDir, "sea-config.json");
  writeFileSync(
    seaConfigPath,
    JSON.stringify({ main: bundlePath, output: blobPath, disableExperimentalSEAWarning: true }, null, 2)
  );

  execFileSync(process.execPath, ["--experimental-sea-config", seaConfigPath], { stdio: "inherit" });

  const outputPath = join(outDir, platformBinaryName());
  copyFileSync(process.execPath, outputPath);

  if (process.platform === "darwin") {
    execFileSync("codesign", ["--remove-signature", outputPath], { stdio: "inherit" });
  }

  await inject(outputPath, "NODE_SEA_BLOB", readFileSync(blobPath), {
    sentinelFuse,
    machoSegmentName: process.platform === "darwin" ? "NODE_SEA" : undefined,
  });

  if (process.platform === "darwin") {
    execFileSync("codesign", ["--sign", "-", outputPath], { stdio: "inherit" });
  }
  if (process.platform !== "win32") {
    chmodSync(outputPath, 0o755);
  }

  cpSync(join(serverRoot, "prisma/migrations"), join(outDir, "prisma/migrations"), { recursive: true });

  rmSync(seaConfigPath, { force: true });
  rmSync(blobPath, { force: true });
  rmSync(bundlePath, { force: true });

  console.log(`Built ${outputPath}`);
  console.log("Ships alongside it: prisma/migrations/");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
