// Packages the already-built server/dist/ into a single native executable
// for the current platform, via Node's Single Executable Applications:
// https://nodejs.org/api/single-executable-applications.html
//
// Unlike the client (client/scripts/build-binary.mjs), @prisma/client's JS
// is fully bundled in (not external) - SEA can't require() an external
// package by bare specifier, only actual Node builtins resolve that way
// (confirmed empirically: an external @prisma/client require failed with
// ERR_UNKNOWN_BUILTIN_MODULE). The one thing that can't be bundled at all
// is the native query engine binary - real machine code, not JS - so it
// ships as the one loose file this script copies next to the executable,
// alongside prisma/migrations/ (needed by src/standaloneMigrate.ts).
//
// Run `npm run build` first (produces dist/) - this script doesn't do that
// itself, so `npm run build:binary` chains both.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { inject } from "postject";

const serverRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(serverRoot);
const outDir = join(serverRoot, "dist-bin");
const sentinelFuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function platformBinaryName() {
  const archSuffix = process.arch === "x64" ? "x64" : process.arch;
  if (process.platform === "win32") return `my-chat-server-win32-${archSuffix}.exe`;
  if (process.platform === "darwin") return `my-chat-server-darwin-${archSuffix}`;
  return `my-chat-server-linux-${archSuffix}`;
}

// Multiple engine files can exist side by side (this schema's binaryTargets
// also lists the two musl targets server/Dockerfile needs) - this picks
// specifically the one matching the CURRENT OS, not just "any engine file".
function nativeEngineFileName(files) {
  if (process.platform === "win32") return files.find((f) => f.endsWith(".dll.node"));
  if (process.platform === "darwin") return files.find((f) => f.endsWith(".dylib.node"));
  return files.find((f) => f.endsWith(".so.node") && !f.includes("musl"));
}

async function main() {
  const distEntry = join(serverRoot, "dist/index.js");
  if (!existsSync(distEntry)) {
    throw new Error(`${distEntry} doesn't exist - run \`npm run build\` first.`);
  }

  const generatedEngineDir = join(repoRoot, "node_modules/.prisma/client");
  const engineFile = existsSync(generatedEngineDir)
    ? nativeEngineFileName(readdirSync(generatedEngineDir))
    : undefined;
  if (!engineFile) {
    throw new Error(
      `Couldn't find a Prisma query engine for ${process.platform} in ${generatedEngineDir} - run \`npx prisma generate\` first.`
    );
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

  const engineOutDir = join(outDir, "node_modules/.prisma/client");
  mkdirSync(engineOutDir, { recursive: true });
  copyFileSync(join(generatedEngineDir, engineFile), join(engineOutDir, engineFile));

  cpSync(join(serverRoot, "prisma/migrations"), join(outDir, "prisma/migrations"), { recursive: true });

  rmSync(seaConfigPath, { force: true });
  rmSync(blobPath, { force: true });
  rmSync(bundlePath, { force: true });

  console.log(`Built ${outputPath}`);
  console.log(`Ships alongside it: node_modules/.prisma/client/${engineFile}, prisma/migrations/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
