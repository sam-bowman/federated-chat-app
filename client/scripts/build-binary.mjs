// Packages the already-built client/dist/ into a single native executable
// per the current platform, via Node's Single Executable Applications
// (SEA): https://nodejs.org/api/single-executable-applications.html
//
// Run `npm run build` first (produces dist/) - this script doesn't do that
// itself, so `npm run build:binary` chains both.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync, chmodSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { inject } from "postject";

const clientRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(clientRoot, "dist");
const outDir = join(clientRoot, "dist-bin");
const sentinelFuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function listFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name));
}

function platformBinaryName() {
  const archSuffix = process.arch === "x64" ? "x64" : process.arch;
  if (process.platform === "win32") return `my-chat-client-win32-${archSuffix}.exe`;
  if (process.platform === "darwin") return `my-chat-client-darwin-${archSuffix}`;
  return `my-chat-client-linux-${archSuffix}`;
}

async function main() {
  if (!existsSync(distDir)) {
    throw new Error(`${distDir} doesn't exist - run \`npm run build\` first.`);
  }

  mkdirSync(outDir, { recursive: true });

  // Bundle the SEA entry (+ its one local import) into a single CJS file -
  // SEA's model assumes a fully self-contained script; this one has no
  // dependencies beyond Node builtins, so bundling is trivial here (unlike
  // the server, which has @prisma/client to reason about separately).
  const bundlePath = join(outDir, "serve.bundle.cjs");
  await esbuild.build({
    entryPoints: [join(clientRoot, "src/bin/serve.ts")],
    outfile: bundlePath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
  });

  // Every file under dist/ becomes an embedded SEA asset, keyed by its path
  // relative to dist/ (matching what requestHandler.ts looks up based on
  // the request's URL pathname) - so the final executable needs no loose
  // files alongside it at all.
  const assets = {};
  for (const file of listFiles(distDir)) {
    assets[relative(distDir, file).split("\\").join("/")] = file;
  }

  const blobPath = join(outDir, "sea-prep.blob");
  const seaConfigPath = join(outDir, "sea-config.json");
  writeFileSync(
    seaConfigPath,
    JSON.stringify(
      { main: bundlePath, output: blobPath, disableExperimentalSEAWarning: true, assets },
      null,
      2
    )
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

  rmSync(seaConfigPath, { force: true });
  rmSync(blobPath, { force: true });
  rmSync(bundlePath, { force: true });

  console.log(`Built ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
