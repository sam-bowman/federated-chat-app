// The entry point of the packaged server binary (scripts/build-binary.mjs). With the argument `admin` it is the operator's admin
// command (`./my-chat-server admin users list`, see docs/deployment/admin-cli.md); with anything else it is the server. The
// server is only loaded in the second case: importing it starts it listening.
import { runAdminMain } from "./cli/adminMain.js";

// A packaged binary's argv starts at the executable, then the arguments.
const args = process.argv.slice(process.argv[1] === process.execPath ? 2 : 1);

if (args[0] === "admin") {
  void runAdminMain(args.slice(1)).then((code) => process.exit(code));
} else {
  void import("./index.js");
}
