// The terminal side of the admin command (adminCli.ts, and the native binary's `admin` argument): the operator's way to manage this server's accounts and communities. It
// talks to the database directly with the same DATABASE_URL the server holds, so there is no network surface and no token:
// being able to run a command where the server runs is the authority (see docs/deployment/admin-cli.md). The commands
// themselves are in admin.ts.
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { prisma } from "../db.js";
import { runAdminCli, type AdminIo } from "./admin.js";

/** Asks on the terminal; a secret is read with what is typed not shown. */
function terminalIo(): AdminIo {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return {
    interactive,
    async confirm(question) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = (await rl.question(`${question} Type "yes" to go on: `)).trim().toLowerCase();
        return answer === "yes";
      } finally {
        rl.close();
      }
    },
    async secret(prompt) {
      let muted = false;
      const output = new Writable({
        write(chunk, _encoding, done) {
          if (!muted) process.stdout.write(chunk);
          done();
        },
      });
      const rl = createInterface({ input: process.stdin, output, terminal: true });
      try {
        process.stdout.write(prompt);
        muted = true;
        const answer = await rl.question("");
        process.stdout.write("\n");
        return answer;
      } finally {
        rl.close();
      }
    },
  };
}

/** Runs the command against the real terminal and database, and returns its exit code. */
export async function runAdminMain(args: string[]): Promise<number> {
  let code = 1;
  try {
    code = await runAdminCli(args, console, terminalIo());
  } catch (error) {
    console.error("Could not do that:", error instanceof Error ? error.message : error);
  } finally {
    await prisma.$disconnect();
  }
  return code;
}
