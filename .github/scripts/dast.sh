#!/usr/bin/env bash
# Dynamic scan (DAST) of a throwaway copy of the app with OWASP ZAP (#250). It starts the server image and the client image against a
# fresh database, signs one ordinary person in, and runs ZAP's API scan (the OpenAPI file, with that person's token) and its baseline
# scan (the web client). ONLY EVER POINT THIS AT THE THROWAWAY STACK IT STARTS: the API scan sends attacks, and creates and deletes things.
#
#   SERVER_IMAGE=... CLIENT_IMAGE=... bash .github/scripts/dast.sh [output-directory]
#
# It writes ZAP's JSON and HTML reports to the output directory (default zap-out) and then judges them with zap-report.mjs, which fails
# only on a HIGH risk alert that is not accepted in .github/zap/ignore. The scanner runs from a container image pinned by tag and digest
# (.github/zap/Dockerfile), not from a third-party action.
set -euo pipefail

server_image="${SERVER_IMAGE:?set SERVER_IMAGE}"
client_image="${CLIENT_IMAGE:?set CLIENT_IMAGE}"
out="${1:-zap-out}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
zap="$(sed -n 's/^FROM \([^ ]*\).*/\1/p' "$root/.github/zap/Dockerfile" | head -n 1)"
run_id="dast-$$"
net="$run_id"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
# ZAP runs as an unprivileged user inside its container and has to write its reports here.
chmod 777 "$out"

cleanup() {
  docker rm -f "$run_id-db" "$run_id-server" "$run_id-client" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
}
trap cleanup EXIT

db_password="$(openssl rand -hex 16)"
person_password="Dast-$(openssl rand -hex 8)-Aa1!"
docker network create "$net" >/dev/null

docker run -d --name "$run_id-db" --network "$net" -e POSTGRES_USER=chat -e "POSTGRES_PASSWORD=$db_password" -e POSTGRES_DB=chat postgres:16-alpine >/dev/null
for _ in $(seq 1 60); do
  docker exec "$run_id-db" pg_isready -U chat >/dev/null 2>&1 && break
  sleep 1
done

# The rate limits are raised so that a scan is not answered with 429 for the rest of its run, which would hide what it came to find.
docker run -d --name "$run_id-server" --network "$net" -p 127.0.0.1:0:4000 \
  -e "DATABASE_URL=postgresql://chat:$db_password@$run_id-db:5432/chat" \
  -e SERVER_DOMAIN=dast.test \
  -e "JWT_ACCESS_SECRET=$(openssl rand -hex 32)" -e "JWT_REFRESH_SECRET=$(openssl rand -hex 32)" \
  -e RATE_LIMIT_MAX=100000000 -e AUTH_RATE_LIMIT_MAX=100000000 -e ADMIN_RATE_LIMIT_MAX=100000000 \
  "$server_image" >/dev/null
docker run -d --name "$run_id-client" --network "$net" -p 127.0.0.1:0:8080 -e "API_URL=http://$run_id-server:4000" "$client_image" >/dev/null

server_port="$(docker port "$run_id-server" 4000/tcp | head -n 1 | sed 's/.*://')"
for _ in $(seq 1 90); do
  curl -fsS "http://127.0.0.1:$server_port/healthz" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:$server_port/healthz" >/dev/null || { docker logs "$run_id-server" | tail -30; echo "the server did not come up"; exit 1; }

# Two people and a few things for them (a community, a role, an invite, a chat, a message), made through the real API, and a copy of the
# OpenAPI file in which the path parameters carry those real ids: see zap-seed.mjs. The scan is signed in as the first person, an
# ordinary account (an access token lives 15 minutes; the scan is limited to less).
DAST_PASSWORD="$person_password" node "$root/.github/scripts/zap-seed.mjs" "http://127.0.0.1:$server_port" "$root/docs/api/openapi.yaml" "$out/openapi.yaml" "$out/seed.json"
token="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).token)' "$out/seed.json")"
rm -f "$out/seed.json"
# The OpenAPI file names an example server; the scan has to talk to this one.
sed -i "s#https://chat.example.com/api/v1#http://$run_id-server:4000/api/v1#" "$out/openapi.yaml"

zap_run() {
  MSYS_NO_PATHCONV=1 docker run --rm --network "$net" -v "$out:/zap/wrk:rw" "$zap" "$@"
}

echo "== ZAP API scan (signed in as an ordinary person)"
# ZAP's Automation Framework, not zap-api-scan.py: with that script's `-z` option for adding the Authorization header, ZAP sent NO request
# to the target at all (checked against a server that logs what arrives), while still reporting a clean scan. Here the same plan is
# checked the same way: every request carries the header, and the paths have real ids in them.
server_url="http://$run_id-server:4000"
cat > "$out/plan.yaml" <<PLAN
env:
  contexts:
    - name: api
      urls: ["$server_url"]
      includePaths: ["$server_url/api/v1.*"]
  parameters:
    failOnError: true
    failOnWarning: false
    progressToStdout: true
jobs:
  - type: replacer
    parameters:
      deleteAllRules: true
    rules:
      - description: auth
        matchType: req_header
        matchString: Authorization
        matchRegex: false
        replacementString: "Bearer $token"
  - type: openapi
    parameters:
      apiFile: /zap/wrk/openapi.yaml
      context: api
  - type: passiveScan-wait
  - type: activeScan
    parameters:
      context: api
      maxScanDurationInMins: 15
  - type: report
    parameters:
      template: traditional-json
      reportDir: /zap/wrk
      reportFile: api
    risks: [high, medium, low, info]
  - type: report
    parameters:
      template: traditional-html
      reportDir: /zap/wrk
      reportFile: api
    risks: [high, medium, low, info]
PLAN
# ZAP prints each setting it reads, the access token included: it is for a throwaway database and lives 15 minutes, but the log is
# kept as an artifact, so it is taken out.
zap_run zap.sh -cmd -autorun /zap/wrk/plan.yaml 2>&1 | sed -u -E 's/(replacementString = Bearer ).*/\1[redacted]/' | tee "$out/api.log"
rm -f "$out/plan.yaml"

echo "== ZAP baseline scan (the web client, passive)"
zap_run zap-baseline.py -t "http://$run_id-client:8080" -I -m 3 -J client.json -r client.html || true

# A scan that imported nothing would pass for the wrong reason: the OpenAPI file has about a hundred operations.
urls="$(grep -oE 'Job openapi added [0-9]+ URLs' "$out/api.log" | head -n 1 | grep -oE '[0-9]+' || true)"
if [ "${urls:-0}" -lt 100 ]; then
  echo "::error::the API scan imported only ${urls:-0} operations from the OpenAPI file (expected 100 or more)"
  exit 1
fi

node "$root/.github/scripts/zap-report.mjs" "$out/api.json" "$out/client.json"
