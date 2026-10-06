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
    password: opts.password ?? "correct horse battery staple",
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
