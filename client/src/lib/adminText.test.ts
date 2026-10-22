import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { adminErrorMessage, isSudoRequired } from "./adminText";

const refused = (status: number, error?: string, extra: object = {}) => new ApiError(status, error ? { error, ...extra } : null);

describe("adminErrorMessage", () => {
  it("says every refusal the server can give in words, never as a code", () => {
    for (const [status, code] of [
      [403, "sudo_required"],
      [401, "invalid_credentials"],
      [401, "invalid_code"],
      [409, "target_is_admin"],
      [409, "cannot_change_own_admin"],
      [409, "target_suspended"],
      [400, "confirm_mismatch"],
      [403, "admin_requires_two_factor"],
      [404, "not_found"],
      [409, "owns_communities"],
      [404, "user_not_found"],
      [404, "not_a_member"],
      [400, "new_owner_must_be_local"],
      [400, "already_owner"],
      [409, "ownership_changed"],
      [409, "not_hosted_here"],
    ] as const) {
      const message = adminErrorMessage(refused(status, code));
      expect(message, code).not.toContain(code);
      expect(message.length, code).toBeGreaterThan(20);
      // Each has its own words: not the answer for something it does not know.
      expect(message, code).not.toBe(adminErrorMessage(new Error("unknown")));
    }
  });

  it("names the communities in the way", () => {
    const message = adminErrorMessage(refused(409, "owns_communities", { communities: [{ name: "Book Club" }, { name: "Chess" }] }));
    expect(message).toContain("Book Club, Chess");
  });

  it("tells a bad password choice from a bad request in general, and a rate limit from a missing account", () => {
    expect(adminErrorMessage(refused(400, "invalid_request"))).toContain("sign-up rules");
    expect(adminErrorMessage(refused(429))).toContain("Too many tries");
    expect(adminErrorMessage(refused(404))).toContain("does not exist");
  });

  it("says something plain for anything it does not know, and never shows what the server sent", () => {
    expect(adminErrorMessage(refused(500, "kaboom_internal"))).toBe("That did not work. Try again.");
    expect(adminErrorMessage(new Error("boom"))).toBe("That did not work. Try again.");
    expect(adminErrorMessage("nonsense")).toBe("That did not work. Try again.");
  });

  it("explains an admin account being off limits, including that the command line can do it", () => {
    expect(adminErrorMessage(refused(409, "target_is_admin"))).toMatch(/command line/);
  });
});

describe("isSudoRequired", () => {
  it("is true only for the one refusal that is answered by asking again", () => {
    expect(isSudoRequired(refused(403, "sudo_required"))).toBe(true);
    expect(isSudoRequired(refused(403, "admin_requires_two_factor"))).toBe(false);
    expect(isSudoRequired(refused(409, "sudo_required"))).toBe(false);
    expect(isSudoRequired(new Error("sudo_required"))).toBe(false);
    expect(isSudoRequired(null)).toBe(false);
  });
});
