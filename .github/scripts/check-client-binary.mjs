// Starts the built client BINARY (client/dist-bin/, made by `npm run build:binary --workspace client`) and checks that it sends the security
// headers (#289) the way the image does: every kind of response, and a policy that names exactly the page's inline scripts. It is the same
// check as check-client-headers.mjs, on the real single-file executable, because what a unit test cannot see is whether the packaging
// kept the page and the code that makes the policy from it together.
//
//   node .github/scripts/check-client-binary.mjs client/dist-bin/my-chat-client-linux-x64
import { spawn } from "node:child_process";
import { checkClient } from "./check-client-headers.mjs";

const binary = process.argv[2];
if (!binary) throw new Error("usage: check-client-binary.mjs <path to the client binary>");

const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const child = spawn(binary, [], { env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", API_URL: "http://localhost:4000" }, stdio: "inherit" });
let exited = false;
child.on("exit", () => (exited = true));

try {
  let up = false;
  for (let i = 0; i < 60 && !up && !exited; i++) {
    up = await fetch(base).then((res) => res.ok, () => false);
    if (!up) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!up) throw new Error(`the binary did not start serving on ${base}${exited ? " (it exited)" : ""}`);

  const problems = await checkClient(base);
  if (problems.length) {
    for (const problem of problems) console.error(`::error::${problem}`);
    process.exitCode = 1;
  } else {
    console.log("The client binary sends every security header on every kind of response, and the policy names exactly the page's inline scripts.");
  }
} finally {
  child.kill();
}
