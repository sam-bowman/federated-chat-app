// The SEA main entry (see client/scripts/build-binary.mjs) - deliberately
// just wiring, no logic of its own, so createRequestHandler stays
// unit-testable without a built binary. Reads assets embedded into the
// executable at build time via `--experimental-sea-config`'s `assets` map.
import { createServer } from "node:http";
import { getAsset, isSea } from "node:sea";
import { createRequestHandler } from "./requestHandler.js";

function readEmbeddedAsset(key: string): ArrayBufferLike | undefined {
  if (!isSea()) return undefined;
  try {
    return getAsset(key);
  } catch {
    return undefined;
  }
}

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";

const server = createServer(createRequestHandler(readEmbeddedAsset));

server.listen(port, host, () => {
  console.log(`[my-chat-client] listening on ${host}:${port}`);
});
