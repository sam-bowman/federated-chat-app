// `node dist/adminCli.js users list` and friends. See cli/adminMain.ts and docs/deployment/admin-cli.md.
import { exitWhenDone, runAdminMain } from "./cli/adminMain.js";

exitWhenDone(await runAdminMain(process.argv.slice(2)));
