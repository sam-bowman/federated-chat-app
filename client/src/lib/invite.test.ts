import { describe, expect, it } from "vitest";
import { inviteCardCode, inviteCode, joinFailureMessage } from "./invite";

describe("inviteCode", () => {
  // A bare id means "on this server" to the join endpoint, so the code has to say where the community lives.
  it("is the community's id and the server it lives on", () => {
    expect(inviteCode({ id: "01JABC", homeserverDomain: "chat.example" })).toBe("01JABC:chat.example");
  });

  it("keeps a port", () => {
    expect(inviteCode({ id: "01JABC", homeserverDomain: "localhost:4000" })).toBe("01JABC:localhost:4000");
  });
});

describe("inviteCardCode", () => {
  it("is the same code, from a card", () => {
    expect(inviteCardCode({ communityId: "01JABC", domain: "chat.example" })).toBe("01JABC:chat.example");
  });
});

describe("joinFailureMessage", () => {
  it.each([
    [403, "banned", "You can't join this community."],
    [404, "not_found", "This community doesn't exist any more."],
    [404, undefined, "This community doesn't exist any more."],
    [502, "federation_unreachable", "Couldn't reach far.example. Try again later."],
    [503, undefined, "Couldn't reach far.example. Try again later."],
    [504, undefined, "Couldn't reach far.example. Try again later."],
    [undefined, "federation_unreachable", "Couldn't reach far.example. Try again later."],
    [500, undefined, "Couldn't join. Try again."],
    [403, "something_else", "Couldn't join. Try again."],
    [undefined, undefined, "Couldn't join. Try again."],
  ])("for status %s and code %s says %j", (status, code, expected) => {
    expect(joinFailureMessage(status, code, "far.example")).toBe(expected);
  });
});
