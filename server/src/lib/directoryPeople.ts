// Whether the people on this server are listed in its directory (DIRECTORY_PEOPLE, #109/#189). The directory itself is DIRECTORY_ENABLED;
// this is about the PEOPLE in it, and follows the same three modes as findability (lib/userDiscoverability.ts):
//
//   - default-off (the default): each person chooses, and starts unlisted;
//   - default-on: each person chooses, and new accounts start listed (only while they can be found, as always: hiding wins);
//   - forced-off: nobody is listed, and nobody can change that.
//
// Strict like the other settings: a value that could be a typo stops the server, because the guess might list people who never agreed.
//
// Kept free of config.ts imports so it can be unit-tested on its own.

export type DirectoryPeopleMode = "default-off" | "default-on" | "forced-off";

const MODES: readonly DirectoryPeopleMode[] = ["default-off", "default-on", "forced-off"];

/** Parses `DIRECTORY_PEOPLE`. Unset or empty means `default-off`; anything but the three names throws. */
export function parseDirectoryPeople(raw: string | undefined): DirectoryPeopleMode {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return "default-off";
  const mode = MODES.find((m) => m === value);
  if (mode) return mode;
  throw new Error(
    `DIRECTORY_PEOPLE is "${raw}", which is not one of ${MODES.join(", ")}. A value that could be a typo is refused rather than guessed, because the guess might list people who never agreed.`
  );
}

/** What a new account starts with. */
export function defaultListed(mode: DirectoryPeopleMode): boolean {
  return mode === "default-on";
}

/** Whether the server has taken the choice away. */
export function listingLocked(mode: DirectoryPeopleMode): boolean {
  return mode === "forced-off";
}

/** Whether someone is listed, given the server's mode and their own choice: the server can only narrow it. */
export function effectiveListed(mode: DirectoryPeopleMode, preference: boolean): boolean {
  return mode !== "forced-off" && preference;
}
