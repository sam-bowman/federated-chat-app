// Whether people on this server can be found by other servers (#109, phase 3): the server's setting, FEDERATION_USER_DISCOVERABILITY,
// and each person's own (User.discoverable). The narrowest wins: a server can switch it off for everyone, a person can only narrow
// what the server allows.
//
//   - default-on  (the default): people can hide themselves; new accounts start findable;
//   - default-off: people can choose; new accounts start hidden until they opt in;
//   - forced-off: nobody is findable by a server they have no relationship with, and no one can change that.
//
// "Found" means a server with no relationship to the person (no friendship, request, conversation or community with someone on it)
// is told the person does not exist; see modules/users/discoverability.ts. Parsed strictly like the other federation settings:
// a value that could be a typo stops the server rather than being guessed, because the guess may be the one that exposes people.
//
// Kept free of config.ts imports so it can be unit-tested on its own.

export type UserDiscoverability = "default-on" | "default-off" | "forced-off";

const MODES: readonly UserDiscoverability[] = ["default-on", "default-off", "forced-off"];

/** Parses `FEDERATION_USER_DISCOVERABILITY`. Unset or empty means `default-on`; anything but the three names throws. */
export function parseUserDiscoverability(raw: string | undefined): UserDiscoverability {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return "default-on";
  const mode = MODES.find((m) => m === value);
  if (mode) return mode;
  throw new Error(
    `FEDERATION_USER_DISCOVERABILITY is "${raw}", which is not one of ${MODES.join(", ")}. A value that could be a typo is refused rather than guessed, because the guess might expose people who meant to be hidden.`
  );
}

/** What a new account starts with. */
export function defaultDiscoverable(mode: UserDiscoverability): boolean {
  return mode === "default-on";
}

/** Whether a person can be found, given the server's mode and their own setting: the server can only narrow, never widen. */
export function effectiveDiscoverable(mode: UserDiscoverability, preference: boolean): boolean {
  return mode !== "forced-off" && preference;
}

/** Whether the server has taken the choice away from people. */
export function discoverabilityLocked(mode: UserDiscoverability): boolean {
  return mode === "forced-off";
}
