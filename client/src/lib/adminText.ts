import { ApiError } from "../api/client";

// What the admin page says when the server refuses something, in words. The server's answers are codes; an admin should never have to read one.

const MESSAGES: Record<string, string> = {
  sudo_required: "Confirm it is you first, then try again.",
  invalid_credentials: "That is not your password.",
  invalid_code: "That code is not right. A code from the app works once: if you just used it, wait for the next one, or use a recovery code.",
  target_is_admin: "This account is an admin. Remove admin from it first (or use the command line): suspending, deleting or changing the password or two-factor sign-in of an admin is not done from this page.",
  cannot_change_own_admin: "You cannot change your own admin access, so the last admin can never be removed from here.",
  target_suspended: "That account is suspended. Unsuspend it before making it an admin.",
  confirm_mismatch: "Type the account's username exactly as shown to erase it.",
  admin_requires_two_factor: "Turn on two-factor sign-in for your account first (Settings).",
  not_found: "That account does not exist, or is not on this server.",
  owns_communities: "That account still owns a community, which would be left without an owner. It has to hand each one to someone else, or the community has to be deleted, first.",
};

/** A plain sentence for something that went wrong. `owns_communities` also names the communities when the server did. */
export function adminErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string; communities?: { name: string }[] } | null;
    const code = body?.error;
    if (code === "owns_communities" && body?.communities?.length) {
      return `${MESSAGES.owns_communities} (${body.communities.map((c) => c.name).join(", ")})`;
    }
    if (code === "invalid_request" && err.status === 400) return "That was not accepted. Check what you typed (a new password has to follow the sign-up rules).";
    if (code && MESSAGES[code]) return MESSAGES[code];
    if (err.status === 429) return "Too many tries. Wait a few minutes and try again.";
    if (err.status === 404) return MESSAGES.not_found;
  }
  return "That did not work. Try again.";
}

/** Whether the server said a sudo token was missing, expired or not valid, which is answered by asking for one again. */
export function isSudoRequired(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403 && (err.body as { error?: string } | null)?.error === "sudo_required";
}
