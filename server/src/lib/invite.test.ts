import { describe, expect, it } from "vitest";
import { inviteFallbackText, inviteReference, parseInvite } from "./invite.js";

const card = { communityId: "01JABCDEF0123456789XYZABCD", domain: "chat.example", name: "Book Club" };

describe("parseInvite", () => {
  it("accepts a well-formed invite", () => {
    expect(parseInvite(card)).toEqual(card);
  });

  it("accepts a domain with a port, as federation domains have", () => {
    expect(parseInvite({ ...card, domain: "localhost:4000" })?.domain).toBe("localhost:4000");
  });

  it("drops fields it does not know, so nothing extra is stored or sent on", () => {
    expect(parseInvite({ ...card, html: "<b>x</b>", iconUrl: "javascript:1" })).toEqual(card);
  });

  it.each([null, undefined, "", "Book Club", 42, [], [card], {}])("is null for %j", (value) => {
    expect(parseInvite(value)).toBeNull();
  });

  it.each([
    ["no name", { ...card, name: undefined }],
    ["an empty name", { ...card, name: "" }],
    ["a name over 100 characters", { ...card, name: "x".repeat(101) }],
    ["no communityId", { ...card, communityId: undefined }],
    ["a communityId with a colon (a reference, not an id)", { ...card, communityId: "abc:chat.example" }],
    ["a communityId with a path", { ...card, communityId: "../etc" }],
    ["an upper-case domain", { ...card, domain: "Chat.Example" }],
    ["a domain with a scheme", { ...card, domain: "https://chat.example" }],
    ["a domain with a path", { ...card, domain: "chat.example/x" }],
    ["a domain with spaces", { ...card, domain: "chat example" }],
    ["no domain", { ...card, domain: undefined }],
  ])("rejects %s", (_name, value) => {
    expect(parseInvite(value)).toBeNull();
  });

  // The name is shown as text by the client, but it is still user-entered: keep it as it is rather than trim or rewrite it.
  it("keeps markup in a name as plain text", () => {
    expect(parseInvite({ ...card, name: "<img src=x onerror=alert(1)>" })?.name).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("inviteReference", () => {
  it("is the community's id and server, the form the join endpoint takes", () => {
    expect(inviteReference(card)).toBe("01JABCDEF0123456789XYZABCD:chat.example");
  });
});

describe("inviteFallbackText", () => {
  it("names the community and carries the code", () => {
    expect(inviteFallbackText(card)).toBe(
      "Invited you to join Book Club (join code: 01JABCDEF0123456789XYZABCD:chat.example)"
    );
  });
});
