// LINK_PREVIEW_IMAGES_ENABLED lets this server also keep a copy of the PICTURE a linked page names (and show a link that is itself a picture), under the
// preview card (#244). It stores files fetched from other people's web servers, so it is OFF unless the operator turns it on, and it does nothing
// unless LINK_PREVIEWS_ENABLED is on too. Parsed strictly, like the other switches: a value that could be a typo stops the server at startup.
// Kept free of config.ts imports so it can be unit-tested on its own.

const YES = new Set(["true", "1", "yes", "on"]);
const NO = new Set(["false", "0", "no", "off"]);

/** Unset or empty means off. `true`, `1`, `yes` and `on` mean on, `false`, `0`, `no` and `off` mean off, in any case; anything else throws. */
export function parseLinkPreviewImagesEnabled(raw: string | undefined): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || NO.has(value)) return false;
  if (YES.has(value)) return true;
  throw new Error(`LINK_PREVIEW_IMAGES_ENABLED is "${raw}", which is not true or false. Use true to let this server keep a copy of the picture a linked page names, or false (the default).`);
}
