// The statuses a person can set for themselves, in the order they are offered. One list for every place
// that offers them (the footer menu and Settings), so the wording cannot differ. OFFLINE is not here: it is
// what others see when you are not connected, not something you choose.

export type PresenceStatus = "ONLINE" | "AWAY" | "BUSY" | "DO_NOT_DISTURB" | "INVISIBLE";

export const PRESENCE_OPTIONS: { value: PresenceStatus; label: string; description: string }[] = [
  { value: "ONLINE", label: "Online", description: "You're available" },
  { value: "AWAY", label: "Away", description: "You've stepped away" },
  { value: "BUSY", label: "Busy", description: "Others see that you're busy" },
  { value: "DO_NOT_DISTURB", label: "Do not disturb", description: "Others see that you'd rather not be disturbed" },
  { value: "INVISIBLE", label: "Invisible", description: "You appear offline to everyone else" },
];

/** The longest custom status the server accepts. */
export const CUSTOM_STATUS_MAX = 128;

const LABELS: Record<string, string> = {
  ...Object.fromEntries(PRESENCE_OPTIONS.map((o) => [o.value, o.label])),
  OFFLINE: "Offline",
};

/** A status in words: "Do not disturb", not DO_NOT_DISTURB. Anything unknown is made readable rather than shown raw. */
export function statusLabel(status: string): string {
  return LABELS[status] ?? status.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
}

/**
 * What the footer says about your own status. Invisible is spelled out, because it looks like offline
 * to everyone else and is easy to forget you are in.
 */
export function statusLine(status: string): string {
  return status === "INVISIBLE" ? "Invisible (others see you offline)" : statusLabel(status);
}
