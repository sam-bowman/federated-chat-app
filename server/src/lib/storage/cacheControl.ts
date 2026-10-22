// How long a browser may keep an uploaded file without asking again (#238). A stored file never changes under its name (each upload is a new random
// name, written once, and a replaced avatar or icon is a different file with a different name), so it can be kept for as long as a browser will:
// without it, every page load asked the server whether each picture had changed, which showed up as a request per picture on every load and, in
// Firefox, as requests it cancelled when several parts of a page asked for the same picture at once.
//
// Only a file that exists is given it: a missing file is a 404 with no such header, and a file that is removed later is simply no longer asked for
// (nothing refers to it), whatever a browser still has. Kept free of config.ts so both storage drivers and the unit tests can use it.

/** A year, in seconds: the most a cache is asked to keep something. */
export const UPLOAD_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/** The `Cache-Control` of an uploaded file, whichever driver serves it. */
export const UPLOAD_CACHE_CONTROL = `public, max-age=${UPLOAD_MAX_AGE_SECONDS}, immutable`;
