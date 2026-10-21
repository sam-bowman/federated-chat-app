// `node dist/adminCli.js users list` and friends. See cli/adminMain.ts and docs/deployment/admin-cli.md.
import { runAdminMain } from "./cli/adminMain.js";

process.exit(await runAdminMain(process.argv.slice(2)));
