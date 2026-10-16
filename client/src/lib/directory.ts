import { BLOCKED_SERVER_MESSAGE, PRIVATE_SERVER_MESSAGE } from "./federation";

// The directory (#109, phase 5): what is said when browsing one does not work. The server decides what is listed; nothing here is a check.

/** Why a directory could not be shown, in words. `server` is the one being browsed, or null for the person's own. */
export function directoryFailureMessage(status: number | undefined, code: string | undefined, server: string | null): string {
  if (code === "directory_disabled") return server ? `${server} doesn't publish a directory.` : "This server doesn't publish a directory.";
  if (code === "federation_disabled") return PRIVATE_SERVER_MESSAGE;
  if (code === "federation_domain_blocked") return BLOCKED_SERVER_MESSAGE;
  if (status === 502 || status === 503 || status === 504 || code === "federation_unreachable") {
    return `Couldn't reach ${server ?? "this server"}. Try again later.`;
  }
  if (status === 400) return "That isn't a server name or a search the directory understands.";
  return "Couldn't load the directory. Try again.";
}

/** What was typed as a server to browse, as the server expects it: trimmed, without a scheme or a trailing slash, lower case; null if nothing. */
export function normalizeServerInput(input: string): string | null {
  const text = input
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  return text === "" ? null : text;
}
