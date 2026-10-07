// Placeholder for local dev and `vite build` - an empty config means
// src/api/client.ts falls through to VITE_API_URL (build-time) and then its
// own localhost default. The Docker image overwrites this file at container
// *startup* (see client/docker-entrypoint.sh), which is what lets one built
// image be pointed at any server without rebuilding it.
window.__RUNTIME_CONFIG__ = {};
