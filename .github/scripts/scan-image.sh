#!/usr/bin/env bash
# Scans one container image for known vulnerabilities with Trivy, run from a pinned container image (.github/trivy/Dockerfile) so the
# scanner is not a third-party action. Used by publish-images.yml (before the tags are made) and image-scan.yml (pull requests that
# change an image, and a weekly look at what is published).
#
#   scan-image.sh <image> [local]
#
# `local` means the image is in the local Docker daemon (built on this runner) rather than in a registry.
#
# What it does: lists every HIGH and CRITICAL finding that has a fix (in the job summary, never failing), then FAILS only if one of
# them is CRITICAL. Findings with no fix are not shown: nobody can act on them, and they would fail a build for something a rebuild
# cannot change. .github/trivy/trivyignore accepts a finding on purpose, with a reason and an expiry.
set -euo pipefail

image="${1:?usage: scan-image.sh <image> [local]}"
mode="${2:-registry}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
scanner="$(sed -n 's/^FROM \([^ ]*\).*/\1/p' "$root/.github/trivy/Dockerfile" | head -n 1)"
cache="${RUNNER_TEMP:-/tmp}/trivy-cache"
mkdir -p "$cache"

docker_args=(run --rm
  -v "$cache:/root/.cache"
  -v "$root/.github/trivy/trivyignore:/trivyignore:ro"
  # Two copies of the vulnerability database, because one registry can refuse a pull when it is busy.
  -e "TRIVY_DB_REPOSITORY=ghcr.io/aquasecurity/trivy-db:2,public.ecr.aws/aquasecurity/trivy-db:2")
if [ "$mode" = "local" ]; then docker_args+=(-v /var/run/docker.sock:/var/run/docker.sock); fi

scan=(image --scanners vuln --ignore-unfixed --ignorefile /trivyignore --no-progress --skip-java-db-update)

echo "Scanning $image with $scanner"
report="$(MSYS_NO_PATHCONV=1 docker "${docker_args[@]}" "$scanner" "${scan[@]}" --severity HIGH,CRITICAL --format table "$image")"
echo "$report"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### $image"
    echo
    echo '```'
    echo "$report" | head -n 300
    echo '```'
  } >> "$GITHUB_STEP_SUMMARY"
fi

# The second run decides. Its database is already in the cache, so it costs seconds.
if ! MSYS_NO_PATHCONV=1 docker "${docker_args[@]}" "$scanner" "${scan[@]}" --severity CRITICAL --exit-code 1 --quiet --format table "$image" > /dev/null; then
  echo "::error::$image has a CRITICAL vulnerability that has a fix. Rebuild the image (the Dockerfiles run apk upgrade), or, if the fix is in the application's own dependencies, update them. See docs/security.md."
  exit 1
fi
echo "No CRITICAL vulnerability with a fix in $image."
