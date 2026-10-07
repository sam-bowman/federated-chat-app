#!/bin/sh
set -e

# Regenerates env-config.js from this container's own env vars every start -
# this is what lets one built image be pointed at any server (API_URL)
# without rebuilding it. See the comment in src/api/client.ts for why this
# exists instead of just using Vite's build-time VITE_API_URL.
cat > /usr/share/nginx/html/env-config.js <<EOF
window.__RUNTIME_CONFIG__ = {
  API_URL: "${API_URL:-}"
};
EOF

exec "$@"
