// LINK_PREVIEWS_ENABLED lets this server read the pages linked in messages, to show a small card under them (#197). It makes
// outbound web requests on behalf of the people on the server, so it is OFF unless the operator turns it on. Parsed strictly, like
// the other switches: a value that could be a typo stops the server at startup rather than being guessed.
// Kept free of config.ts imports so it can be unit-tested on its own.

const YES = new Set(["true", "1", "yes", "on"]);
const NO = new Set(["false", "0", "no", "off"]);

/** Unset or empty means off. `true`, `1`, `yes` and `on` mean on, `false`, `0`, `no` and `off` mean off, in any case; anything else throws. */
export function parseLinkPreviewsEnabled(raw: string | undefined): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || NO.has(value)) return false;
  if (YES.has(value)) return true;
  throw new Error(`LINK_PREVIEWS_ENABLED is "${raw}", which is not true or false. Use true to let this server read linked pages for previews, or false (the default).`);
}
