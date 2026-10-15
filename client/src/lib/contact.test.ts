import { describe, expect, it } from "vitest";
import { CONTACT_CHOICES, contactRefusalMessage, isContactRefusal } from "./contact";

describe("the choices", () => {
  // These are the names the server accepts (server/src/lib/contactPolicy.ts); one it does not know is a 400.
  it("are exactly the three the server knows, with the open one first", () => {
    expect(CONTACT_CHOICES.map((c) => c.value)).toEqual(["ANYONE", "SHARED_COMMUNITY", "LOCAL_ONLY"]);
  });

  it("each say in words what they let in", () => {
    for (const choice of CONTACT_CHOICES) {
      expect(choice.label.length).toBeGreaterThan(3);
      expect(choice.description).toMatch(/friend request/);
    }
  });
});

describe("a refusal", () => {
  it("is recognised only by the server's own code", () => {
    expect(isContactRefusal("contact_not_allowed")).toBe(true);
    for (const other of ["federation_disabled", "blocked", "user_not_found", undefined]) expect(isContactRefusal(other)).toBe(false);
  });

  it("is worded for what was tried, and never says what the other person chose", () => {
    expect(contactRefusalMessage("request")).toBe("This person isn't accepting friend requests from you.");
    expect(contactRefusalMessage("conversation")).toBe("This person isn't accepting conversations from you.");
    for (const what of ["request", "conversation"] as const) expect(contactRefusalMessage(what)).not.toMatch(/community|server/i);
  });
});
