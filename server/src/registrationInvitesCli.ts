// `node dist/registrationInvitesCli.js create|list|revoke`: the operator's way to make the codes an invite-only server asks
// for (REGISTRATION_INVITE_ONLY). It talks to the database directly with the same DATABASE_URL the server holds, so there
// is no network surface and no token: being able to run a command where the server runs is the authority. The commands
// themselves are in cli/registrationInvites.ts.
import { config } from "./config.js";
import { prisma } from "./db.js";
import { runRegistrationInvitesCli } from "./cli/registrationInvites.js";

let code = 1;
try {
  code = await runRegistrationInvitesCli(process.argv.slice(2), prisma, console, {
    registrationEnabled: config.registrationEnabled,
    registrationInviteOnly: config.registrationInviteOnly,
  });
} catch (error) {
  console.error("Could not do that:", error instanceof Error ? error.message : error);
} finally {
  await prisma.$disconnect();
}
process.exit(code);
