// REGISTRATION_INVITE_ONLY makes this server ask for a code before it makes an account. It sits on top of
// REGISTRATION_ENABLED: with registration off nobody can register, code or not.
//
// A flag that asks for MORE protection must never be misread, because the cost of a typo is an open door the operator
// believed was closed ("ture" silently leaving the server open to anyone). So, like FEDERATION_ENABLED, only the usual
// spellings of yes and no are accepted and anything else stops the server at startup, saying which values are.
//
// Kept free of config.ts imports so it can be unit-tested on its own.

const YES = new Set(["true", "1", "yes", "on"]);
const NO = new Set(["false", "0", "no", "off"]);

/**
 * Parses `REGISTRATION_INVITE_ONLY`. Unset or empty means off (how every server has always behaved). `true`, `1`, `yes` and
 * `on` mean on, `false`, `0`, `no` and `off` mean off, in any case; anything else throws.
 */
export function parseRegistrationInviteOnly(raw: string | undefined): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || NO.has(value)) return false;
  if (YES.has(value)) return true;
  throw new Error(
    `REGISTRATION_INVITE_ONLY is "${raw}", which is not true or false. Use true to ask for an invite code or false (the default); a value that could be a typo is refused rather than guessed, because a server meant to be invite-only must not end up open.`
  );
}
