// What a search is matched with. Prisma's `contains` puts the text into a LIKE pattern as it is, so a `%` or `_` someone typed would be a
// wildcard (a search for "%" would match everything, "a_" any two letters starting with a); they are escaped here so a search means what it says.
// Use it for every `contains` that takes text from a person.

/** `q` with the characters LIKE treats specially escaped, for `{ contains: literally(q) }`. */
export const literally = (q: string): string => q.replace(/[\\%_]/g, "\\$&");
