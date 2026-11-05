#!/usr/bin/env bash
# Audits the desktop app's Rust dependencies (a Cargo.lock) against the RustSec advisory database. Used by the `dependency-audit` job in
# ci.yml, beside `npm audit`.
#
#   cargo-audit.sh [path/to/Cargo.lock]      (default: client/src-tauri/Cargo.lock)
#
# cargo-audit is a prebuilt binary from its own GitHub release, pinned by version AND sha256 below, so there is no third-party action in
# the supply chain of the check and no five-minute `cargo install`. To move to a newer one, change both lines together:
#   gh api repos/rustsec/rustsec/releases/tags/cargo-audit/vX.Y.Z --jq '.assets[]|select(.name|test("x86_64-unknown-linux-musl"))|.digest'
# The advisory DATABASE is not pinned (it is fetched fresh, as `npm audit` asks npm), which is the point of running it.
#
# What it does: runs `cargo audit --json` and hands the result to cargo-audit-report.mjs, which lists everything and FAILS only on a
# vulnerability that is not accepted in .github/cargo-audit/ignore. cargo-audit's own exit code is deliberately ignored: the report
# script treats a run that did not read the database as a failure instead.
set -euo pipefail

VERSION="0.22.2"
SHA256="7fb9497f8594b389e5fce5ef9b92db08432996895b2e0c5a0167a69ed445c428"
ASSET="cargo-audit-x86_64-unknown-linux-musl-v${VERSION}.tgz"

root="$(cd "$(dirname "$0")/../.." && pwd)"
lockfile="${1:-client/src-tauri/Cargo.lock}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

curl -fsSL --retry 3 -o "$work/$ASSET" "https://github.com/rustsec/rustsec/releases/download/cargo-audit%2Fv${VERSION}/${ASSET}"
echo "${SHA256}  ${work}/${ASSET}" | sha256sum -c -
tar -xzf "$work/$ASSET" -C "$work"
binary="$(find "$work" -type f -name cargo-audit | head -n 1)"
test -n "$binary" || { echo "cargo-audit is not in the downloaded archive" >&2; exit 1; }
chmod +x "$binary"

# Not `set -e` for this one: it exits 1 when it finds a vulnerability, and the report below is what decides.
"$binary" audit --file "$root/$lockfile" --json > "$work/audit.json" || true
node "$root/.github/scripts/cargo-audit-report.mjs" "$work/audit.json"
