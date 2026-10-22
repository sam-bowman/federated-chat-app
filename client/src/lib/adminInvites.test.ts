import { describe, expect, it } from "vitest";
import serverInvites from "../../../server/src/lib/registrationInvites.ts?raw";
import { INVITE_LIMITS, inviteLink, inviteSummary, whole } from "./adminInvites";

const fromServer = (name: string): number => {
  const match = new RegExp(`export const ${name} = ([0-9_]+);`).exec(serverInvites);
  if (!match) throw new Error(`${name} is not in the server's lib/registrationInvites.ts`);
  return Number(match[1].replace(/_/g, ""));
};

describe("INVITE_LIMITS", () => {
  it("are the limits the server accepts, so the form never offers what would be refused (or refuses what would be accepted)", () => {
    expect(INVITE_LIMITS).toEqual({
      maxUses: fromServer("MAX_REGISTRATION_USES"),
      maxDays: fromServer("MAX_EXPIRY_DAYS"),
      maxCount: fromServer("MAX_CODES_PER_CREATE"),
      maxNote: fromServer("MAX_NOTE_LENGTH"),
      defaultUses: fromServer("DEFAULT_MAX_USES"),
      defaultDays: fromServer("DEFAULT_EXPIRY_DAYS"),
    });
  });
});

describe("inviteSummary", () => {
  const end = "2026-11-12T12:00:00.000Z";
  const date = new Date(end).toLocaleDateString();

  it("says how much of a limited code is used and when it ends", () => {
    expect(inviteSummary({ uses: 1, maxUses: 3, expiresAt: end, status: "active" })).toBe(`1 of 3 used · ends ${date}`);
  });

  it("says an unlimited code that never ends so, in words", () => {
    expect(inviteSummary({ uses: 7, maxUses: null, expiresAt: null, status: "active" })).toBe("7 used · never ends");
  });

  it("says a code that has already ended ended", () => {
    expect(inviteSummary({ uses: 0, maxUses: 1, expiresAt: end, status: "expired" })).toBe(`0 of 1 used · ended ${date}`);
    expect(inviteSummary({ uses: 1, maxUses: 1, expiresAt: end, status: "used_up" })).toBe(`1 of 1 used · ends ${date}`);
  });
});

describe("inviteLink", () => {
  it("goes to the register screen on this site with the code in it", () => {
    expect(inviteLink("ABCDEFGHJK", "https://chat.example")).toBe("https://chat.example/register?invite=ABCDEFGHJK");
  });

  it("encodes the code, so nothing in it can change the address", () => {
    expect(inviteLink("a&b=c#d", "https://chat.example")).toBe("https://chat.example/register?invite=a%26b%3Dc%23d");
  });

  it("uses the address of the page by default", () => {
    expect(inviteLink("ABCDEFGHJK")).toBe(`${window.location.origin}/register?invite=ABCDEFGHJK`);
  });
});

describe("whole", () => {
  it("takes whole numbers inside the range, with spaces around them taken off", () => {
    expect(whole("5", 1, 10)).toBe(5);
    expect(whole(" 7 ", 1, 10)).toBe(7);
    expect(whole("1", 1, 10)).toBe(1);
    expect(whole("10", 1, 10)).toBe(10);
  });

  it("refuses everything else", () => {
    for (const text of ["0", "11", "", "  ", "1.5", "-1", "1e1", "abc", "5 5", "+5"]) expect(whole(text, 1, 10), JSON.stringify(text)).toBeUndefined();
  });
});
