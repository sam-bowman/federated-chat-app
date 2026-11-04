/**
 * Loads the app afresh at a path (a whole page load, not a route change). Used when the account in use changes (#49): a page that has been
 * showing one person's chats holds their messages, lists, call and caches in memory in too many places to clear one by one, and a load is the
 * one way to be sure none of it is still there for the next person. The server's own first answer is already fetched in parallel at the
 * start of a load (lib/bootPrefetch.ts), so it costs about one round trip.
 */
export function goToApp(path = "/") {
  window.location.assign(path);
}
