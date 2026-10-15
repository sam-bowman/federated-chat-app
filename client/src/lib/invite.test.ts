import { describe, expect, it } from "vitest";
import {
  INVITE_EXPIRY_CHOICES,
  INVITE_STATUS_LABELS,
  INVITE_USE_CHOICES,
  inviteCardCode,
  inviteCode,
  inviteExpiryText,
  inviteLimitText,
  inviteUsesText,
  isInviteProblem,
  isOpenToAnyone,
  joinByIdFailureMessage,
  joinFailureMessage,
  referenceDomain,
} from "./invite";

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

describe("inviteCardCode with an invite", () => {
  it("carries the card's invite after a #, so joining from the card uses it", () => {
    expect(inviteCardCode({ communityId: "01JABC", domain: "chat.example", code: "K7M2QXR9TB" })).toBe("01JABC:chat.example#K7M2QXR9TB");
  });

  it("has no # for an older card without one", () => {
    expect(inviteCardCode({ communityId: "01JABC", domain: "chat.example", code: undefined })).toBe("01JABC:chat.example");
  });
});

describe("isOpenToAnyone", () => {
  it("is true unless the community says it is not, so a server that predates invites counts as open", () => {
    expect(isOpenToAnyone({ openJoin: true })).toBe(true);
    expect(isOpenToAnyone({ openJoin: undefined })).toBe(true);
    expect(isOpenToAnyone({ openJoin: false })).toBe(false);
  });
});

describe("joinFailureMessage for an invitation that is no good", () => {
  it.each([
    ["invite_expired", "This invitation has expired. Ask for a new one."],
    ["invite_revoked", "This invitation was cancelled. Ask for a new one."],
    ["invite_used_up", "This invitation has already been used. Ask for a new one."],
    ["invite_invalid", "This invitation isn't valid."],
    ["invite_required", "This community is invite-only. Ask a member to invite you."],
  ])("says what %s means", (code, expected) => {
    expect(joinFailureMessage(403, code, "far.example")).toBe(expected);
  });

  it("explains it whatever the status, since the code is what matters", () => {
    expect(joinFailureMessage(undefined, "invite_expired", "far.example")).toBe("This invitation has expired. Ask for a new one.");
  });
});

describe("isInviteProblem", () => {
  it("is true for each way an invitation can be no good, and nothing else", () => {
    for (const code of ["invite_expired", "invite_revoked", "invite_used_up", "invite_invalid", "invite_required"]) {
      expect(isInviteProblem(code), code).toBe(true);
    }
    for (const code of ["banned", "not_found", "federation_unreachable", undefined, "", "toString", "constructor", "__proto__"]) {
      expect(isInviteProblem(code), String(code)).toBe(false);
    }
  });
});

describe("referenceDomain", () => {
  it("is the server in what was pasted, with or without a code and with a port", () => {
    expect(referenceDomain("01JABC:far.example")).toBe("far.example");
    expect(referenceDomain("01JABC:far.example#K7M2QXR9TB")).toBe("far.example");
    expect(referenceDomain("  01JABC:localhost:4001#K7M2QXR9TB  ")).toBe("localhost:4001");
  });

  it("is null when it names none", () => {
    expect(referenceDomain("01JABC")).toBeNull();
    expect(referenceDomain("01JABC#K7M2QXR9TB")).toBeNull();
    expect(referenceDomain("01JABC:")).toBeNull();
    expect(referenceDomain("")).toBeNull();
  });
});

describe("joinByIdFailureMessage", () => {
  const ref = "01JABC:far.example#K7M2QXR9TB";

  it("explains a problem with the invitation, a ban and an unreachable server, naming the server", () => {
    expect(joinByIdFailureMessage(403, "invite_expired", ref)).toBe("This invitation has expired. Ask for a new one.");
    expect(joinByIdFailureMessage(403, "banned", ref)).toBe("You can't join this community.");
    expect(joinByIdFailureMessage(502, "federation_unreachable", ref)).toBe("Couldn't reach far.example. Try again later.");
  });

  it("does not know which server to name when none was typed", () => {
    expect(joinByIdFailureMessage(502, undefined, "01JABC")).toBe("Couldn't reach that server. Try again later.");
  });

  it("keeps the box's own message for a mistyped id or anything else", () => {
    expect(joinByIdFailureMessage(404, "not_found", ref)).toBe("Couldn't find or join that community.");
    expect(joinByIdFailureMessage(400, "invalid_request", "nonsense")).toBe("Couldn't find or join that community.");
    expect(joinByIdFailureMessage(undefined, undefined, ref)).toBe("Couldn't find or join that community.");
  });
});

describe("the choices when making an invite", () => {
  it("offer exactly the lifetimes the server accepts: 1 hour, 24 hours, 7 days or never", () => {
    expect(INVITE_EXPIRY_CHOICES.map((c) => c.value)).toEqual([3600, 86_400, 604_800, null]);
  });

  it("offer no limit and a handful of whole numbers within the server's range of 1 to 1000", () => {
    expect(INVITE_USE_CHOICES[0].value).toBeNull();
    for (const choice of INVITE_USE_CHOICES.slice(1)) {
      expect(Number.isInteger(choice.value)).toBe(true);
      expect(choice.value!).toBeGreaterThanOrEqual(1);
      expect(choice.value!).toBeLessThanOrEqual(1000);
    }
  });
});

describe("inviteExpiryText", () => {
  const now = new Date("2026-10-15T12:00:00Z");
  const at = (ms: number) => new Date(now.getTime() + ms).toISOString();

  it("says an invite with no expiry never expires", () => {
    expect(inviteExpiryText(null, now)).toBe("Never expires");
  });

  it("says Expired once the time has come", () => {
    expect(inviteExpiryText(at(0), now)).toBe("Expired");
    expect(inviteExpiryText(at(-5000), now)).toBe("Expired");
  });

  it("counts minutes under an hour, rounding up so it never says 0 minutes", () => {
    expect(inviteExpiryText(at(1000), now)).toBe("Expires in 1 minute");
    expect(inviteExpiryText(at(61_000), now)).toBe("Expires in 2 minutes");
    expect(inviteExpiryText(at(59 * 60_000), now)).toBe("Expires in 59 minutes");
  });

  it("counts hours up to two days, and days after that", () => {
    expect(inviteExpiryText(at(3_600_000), now)).toBe("Expires in 1 hour");
    expect(inviteExpiryText(at(3 * 3_600_000 - 1000), now)).toBe("Expires in 3 hours");
    expect(inviteExpiryText(at(47 * 3_600_000), now)).toBe("Expires in 47 hours");
    expect(inviteExpiryText(at(3 * 86_400_000 - 1000), now)).toBe("Expires in 3 days");
    expect(inviteExpiryText(at(7 * 86_400_000), now)).toBe("Expires in 7 days");
  });

  it("does not claim a date it cannot read is a time", () => {
    expect(inviteExpiryText("not a date", now)).toBe("Never expires");
  });
});

describe("inviteUsesText", () => {
  it("says how many of the limit are used, or how many uses with no limit", () => {
    expect(inviteUsesText({ uses: 2, maxUses: 5 })).toBe("2 of 5 used");
    expect(inviteUsesText({ uses: 0, maxUses: 1 })).toBe("0 of 1 used");
    expect(inviteUsesText({ uses: 1, maxUses: null })).toBe("1 use");
    expect(inviteUsesText({ uses: 12, maxUses: null })).toBe("12 uses");
    expect(inviteUsesText({ uses: 0, maxUses: null })).toBe("0 uses");
  });
});

describe("inviteLimitText", () => {
  it("says who can use a new invite", () => {
    expect(inviteLimitText(null)).toBe("Any number of people");
    expect(inviteLimitText(1)).toBe("One person");
    expect(inviteLimitText(25)).toBe("25 people");
  });
});

describe("INVITE_STATUS_LABELS", () => {
  it("has a label for every status", () => {
    expect(INVITE_STATUS_LABELS).toEqual({ active: "Active", revoked: "Revoked", expired: "Expired", used_up: "Used up" });
  });
});

describe("a server this one does not talk to", () => {
  it("is named, and said to be the reason, rather than the invitation or an outage", () => {
    expect(joinFailureMessage(403, "federation_domain_blocked", "far.example")).toBe("This server doesn't connect to far.example, so you can't join a community there.");
    expect(joinByIdFailureMessage(403, "federation_domain_blocked", "01JABC:far.example#K7M2QXR9TB")).toBe(
      "This server doesn't connect to far.example, so you can't join a community there."
    );
  });

  it("is not an invitation problem, so a card keeps Join in case the lists change", () => {
    expect(isInviteProblem("federation_domain_blocked")).toBe(false);
  });
});

describe("a private server", () => {
  it("is named as the reason, whatever the status, since it is not the invitation or the other server", () => {
    expect(joinFailureMessage(403, "federation_disabled", "far.example")).toBe("This server doesn't connect to other servers, so you can't join a community on one.");
    expect(joinByIdFailureMessage(403, "federation_disabled", "01JABC:far.example")).toBe(
      "This server doesn't connect to other servers, so you can't join a community on one."
    );
  });

  it("is not mistaken for an unreachable server, which is worth trying again", () => {
    expect(joinFailureMessage(403, "federation_disabled", "far.example")).not.toContain("Try again");
  });

  it("is not an invitation problem, so a card keeps Join in case the server is turned back on", () => {
    expect(isInviteProblem("federation_disabled")).toBe(false);
  });
});
