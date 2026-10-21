// @ts-nocheck - imports the server's TypeScript sources, which this folder's own type check should not be pulled into.
//
// What run-server.mjs starts instead of `src/index.ts`: the real server, with one difference. Link previews (#197) refuse pages on
// this machine, and the pages the end-to-end tests can serve are on this machine, so this lets the previews reach them. The server
// itself has no setting for that, on purpose (an operator who could turn it on could point it at their own network); the switch
// is a variable only code in this process can reach, and nothing outside the end-to-end suite starts this file.
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const src = join(process.cwd(), "src");
const { testHooks } = await import(pathToFileURL(join(src, "modules", "linkPreview", "service.ts")).href);
testHooks.allowPrivate = true;
await import(pathToFileURL(join(src, "index.ts")).href);
