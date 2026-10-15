// FEDERATION_ENABLED switches this server between talking to other homeservers and not. Off, the server is private: it
// answers no federation request, sends none, and starts no relationship with a person or community on another server.
//
// A flag that turns a feature off must never be misread, because the cost of a typo is the opposite of what the operator
// meant ("fasle" silently leaving a private server public). So unlike a lenient "anything but false", only the usual
// spellings of yes and no are accepted and anything else stops the server at startup, saying which values are.
//
// Kept free of config.ts imports so it can be unit-tested on its own.

const YES = new Set(["true", "1", "yes", "on"]);
const NO = new Set(["false", "0", "no", "off"]);

/**
 * Parses `FEDERATION_ENABLED`. Unset or empty means on (how every server has always behaved). `true`, `1`, `yes` and `on`
 * mean on, `false`, `0`, `no` and `off` mean off, in any case; anything else throws.
 */
export function parseFederationEnabled(raw: string | undefined): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || YES.has(value)) return true;
  if (NO.has(value)) return false;
  throw new Error(
    `FEDERATION_ENABLED is "${raw}", which is not true or false. Use true (the default) or false; a value that could be a typo is refused rather than guessed, because a private server must not end up public.`
  );
}
