import { describe, expect, it } from "vitest";
import { DIRECTORY_SEARCH_MAX_CHARACTERS, directoryQueryString, parseDirectoryQuery, sanitizeCommunityPage, sanitizePeoplePage } from "./directory.js";
import { parseDirectoryEnabled } from "./directorySetting.js";

describe("parseDirectoryEnabled", () => {
  it("is off when unset or blank: nothing is published until the operator says so", () => {
    expect(parseDirectoryEnabled(undefined)).toBe(false);
    expect(parseDirectoryEnabled("")).toBe(false);
    expect(parseDirectoryEnabled("  ")).toBe(false);
  });

  it("reads the usual spellings of yes and no, in any case", () => {
    for (const yes of ["true", "1", "yes", "on", " TRUE "]) expect(parseDirectoryEnabled(yes)).toBe(true);
    for (const no of ["false", "0", "no", "off", "OFF"]) expect(parseDirectoryEnabled(no)).toBe(false);
  });

  it.each(["ture", "enabled", "2", "publish"])("refuses %s rather than guessing", (value) => {
    expect(() => parseDirectoryEnabled(value)).toThrow(/DIRECTORY_ENABLED.*not true or false/);
  });
});

describe("parseDirectoryQuery", () => {
  it("is no search and the first page when nothing is asked", () => {
    expect(parseDirectoryQuery({})).toEqual({ ok: true, q: null, cursor: null });
    expect(parseDirectoryQuery({ q: "  ", cursor: "" })).toEqual({ ok: true, q: null, cursor: null });
  });

  it("trims a search and keeps a cursor", () => {
    expect(parseDirectoryQuery({ q: "  book club ", cursor: "01M4ZY34DY638B7J24A3RMYRMC" })).toEqual({
      ok: true,
      q: "book club",
      cursor: "01M4ZY34DY638B7J24A3RMYRMC",
    });
  });

  it("refuses what is not a plain search or a cursor an earlier page could have given", () => {
    for (const bad of [
      { q: ["a", "b"] },
      { q: { $ne: "" } },
      { q: "x".repeat(DIRECTORY_SEARCH_MAX_CHARACTERS + 1) },
      { q: "line\nbreak" },
      { cursor: "has space" },
      { cursor: "a".repeat(65) },
      { cursor: ["a"] },
      { cursor: "a/b" },
    ]) {
      expect(parseDirectoryQuery(bad), JSON.stringify(bad)).toEqual({ ok: false });
    }
  });
});

describe("directoryQueryString", () => {
  it("is empty for the first page of everything, and encodes what it carries", () => {
    expect(directoryQueryString(null, null)).toBe("");
    expect(directoryQueryString("a&b=c", "01ABC")).toBe("?q=a%26b%3Dc&cursor=01ABC");
    expect(directoryQueryString(null, "01ABC")).toBe("?cursor=01ABC");
  });
});

const community = (over: Record<string, unknown> = {}) => ({
  id: "01M4ZY34DY638B7J24A3RMYRMC",
  name: "Book Club",
  description: "We read.",
  iconUrl: "https://far.example/uploads/x.png",
  iconText: null,
  iconColor: null,
  memberCount: 12,
  ...over,
});

describe("sanitizeCommunityPage", () => {
  it("keeps a good listing, saying the server that was asked is where it lives, whatever the item says", () => {
    const page = sanitizeCommunityPage({ items: [community({ domain: "evil.example" })], nextCursor: "01ABC" }, "far.example");

    expect(page).toEqual({
      items: [
        {
          id: "01M4ZY34DY638B7J24A3RMYRMC",
          domain: "far.example",
          name: "Book Club",
          description: "We read.",
          iconUrl: "https://far.example/uploads/x.png",
          iconText: null,
          iconColor: null,
          memberCount: 12,
        },
      ],
      nextCursor: "01ABC",
    });
  });

  it("drops an item without a usable id or name, and keeps the rest", () => {
    const page = sanitizeCommunityPage(
      { items: [community({ id: "has space" }), community({ name: "" }), community({ name: "bell\u0007" }), community({ name: "n".repeat(101) }), community({ id: 5 }), "text", null, community()] },
      "far.example"
    );

    expect(page.items.map((i) => i.name)).toEqual(["Book Club"]);
  });

  it("drops each unusable field, not the item: a path or script URL, bad letters or colour, a description with control characters, a strange count", () => {
    const page = sanitizeCommunityPage(
      {
        items: [
          community({ iconUrl: "/uploads/x.png", iconText: "toolong", iconColor: "red", description: "a\u0000b", memberCount: -3 }),
          community({ iconUrl: "javascript:alert(1)", memberCount: 1.5 }),
          community({ memberCount: "many" }),
        ],
      },
      "far.example"
    );

    for (const item of page.items) expect(item.memberCount).toBe(0);
    expect(page.items.slice(0, 2).map((i) => i.iconUrl)).toEqual([null, null]); // a path, and a script URL
    expect(page.items[2].iconUrl).toBe("https://far.example/uploads/x.png"); // a good one is kept
    expect(page.items[0]).toMatchObject({ iconText: null, iconColor: null, description: null });
    expect(page.items).toHaveLength(3);
  });

  it("keeps the line breaks in a description", () => {
    expect(sanitizeCommunityPage({ items: [community({ description: "one\ntwo" })] }, "far.example").items[0].description).toBe("one\ntwo");
  });

  it("is an empty page for anything that is not a page, and never takes more than 50 items", () => {
    for (const nonsense of [null, undefined, "x", 5, [], {}, { items: "x" }, { items: {} }]) {
      expect(sanitizeCommunityPage(nonsense, "far.example")).toEqual({ items: [], nextCursor: null });
    }
    expect(sanitizeCommunityPage({ items: Array.from({ length: 500 }, () => community()) }, "far.example").items).toHaveLength(50);
  });

  it("ignores a next cursor that could not be one", () => {
    expect(sanitizeCommunityPage({ items: [], nextCursor: "a b" }, "far.example").nextCursor).toBeNull();
    expect(sanitizeCommunityPage({ items: [], nextCursor: ["x"] }, "far.example").nextCursor).toBeNull();
  });
});

const person = (over: Record<string, unknown> = {}) => ({
  id: "01M4ZY34DY638B7J24A3RMYRMC",
  username: "rex",
  displayName: "Rex",
  avatarUrl: "https://far.example/uploads/rex.png",
  bio: "Hello",
  ...over,
});

describe("sanitizePeoplePage", () => {
  it("keeps a good listing, on the server that was asked", () => {
    const page = sanitizePeoplePage({ items: [person({ domain: "evil.example" })] }, "far.example");

    expect(page.items).toEqual([
      { id: "01M4ZY34DY638B7J24A3RMYRMC", username: "rex", domain: "far.example", displayName: "Rex", avatarUrl: "https://far.example/uploads/rex.png", bio: "Hello" },
    ]);
  });

  it("drops a person whose username or name is not right", () => {
    const page = sanitizePeoplePage(
      { items: [person({ username: "Re x" }), person({ username: "ab" }), person({ displayName: "" }), person({ displayName: "x".repeat(65) }), person({ id: "a b" }), person()] },
      "far.example"
    );

    expect(page.items.map((p) => p.username)).toEqual(["rex"]);
  });

  it("drops a picture that is not an absolute http(s) URL, and a bio that is not text", () => {
    const page = sanitizePeoplePage({ items: [person({ avatarUrl: "/uploads/rex.png", bio: { x: 1 } }), person({ avatarUrl: "data:text/html,x" })] }, "far.example");

    expect(page.items.map((p) => [p.avatarUrl, p.bio])).toEqual([[null, null], [null, "Hello"]]);
  });

  it("is an empty page for anything that is not a page", () => {
    expect(sanitizePeoplePage(null, "far.example")).toEqual({ items: [], nextCursor: null });
  });
});
