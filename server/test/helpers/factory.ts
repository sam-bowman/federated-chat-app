import type { PublicUser } from "../../src/lib/serialize.js";
import { api } from "./app.js";

interface RegisteredUser {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
}

export async function registerUser(
  username: string,
  opts: { password?: string; displayName?: string } = {}
): Promise<RegisteredUser> {
  const res = await api.post("/api/v1/auth/register").send({
    username,
    // Meets the password policy (server/src/modules/auth/routes.ts's
    // passwordSchema: 8+ chars, upper+lower+number+symbol) - the old
    // all-lowercase "correct horse battery staple" default stopped
    // passing registration once that policy was added.
    password: opts.password ?? "Correct-Horse-Battery-Staple-1",
    displayName: opts.displayName,
  });
  if (res.status !== 201) {
    throw new Error(`registerUser(${username}) failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body as RegisteredUser;
}

export function authHeader(accessToken: string): { Authorization: string } {
  return { Authorization: `Bearer ${accessToken}` };
}
