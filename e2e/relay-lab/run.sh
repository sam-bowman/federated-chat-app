# Runs inside the `browser` container (see docker-compose.yml).
set -e
apt-get update -qq >/dev/null && apt-get install -y -qq iptables socat >/dev/null 2>&1

# The e2e stack runs on the host and the client has localhost addresses baked in, so make them mean the host from in here.
# The client is the second Vite from README.md (port 5290, reachable from a container), shown to the page as localhost:5273 so the
# server's CORS list accepts it.
socat TCP-LISTEN:4100,fork,reuseaddr,bind=127.0.0.1 TCP:host.docker.internal:4100 &
socat TCP-LISTEN:5273,fork,reuseaddr,bind=127.0.0.1 TCP:host.docker.internal:5290 &
socat TCP-LISTEN:7880,fork,reuseaddr,bind=127.0.0.1 TCP:172.30.0.10:7880 &

if [ "${BLOCK:-1}" = "1" ]; then
  # The network the issue describes: nothing to LiveKit but TCP (its signalling on 7880, and TLS on 443 for the relay).
  iptables -A OUTPUT -d 172.30.0.10 -p udp -j DROP
  iptables -A OUTPUT -d 172.30.0.10 -p tcp --dport 7881 -j DROP
  echo "BLOCKED: every UDP packet and tcp/7881 to LiveKit"
fi

npm init -y >/dev/null 2>&1 && npm i playwright@1.64.1 >/dev/null 2>&1
node probe.mjs
