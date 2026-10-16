import { describe, expect, it } from "vitest";
import { friendRequestFailure } from "./friendRequest";

describe("friendRequestFailure", () => {
  it("says what each answer comes to, and which are settled (nothing more to try)", () => {
    expect(friendRequestFailure("already_friends")).toEqual({ message: "You're already friends.", settled: true });
    expect(friendRequestFailure("request_already_pending")).toEqual({
      message: "There is already a pending request with them: see the Incoming and Outgoing tabs.",
      settled: true,
    });
    expect(friendRequestFailure("blocked")).toEqual({ message: "You can't send a request to them.", settled: false });
    expect(friendRequestFailure("user_not_found")).toEqual({ message: "No one with that name was found.", settled: false });
  });

  it("explains a refusal by the other person's setting, and by a server that will not connect, in their own words", () => {
    expect(friendRequestFailure("contact_not_allowed")).toEqual({ message: "This person isn't accepting friend requests from you.", settled: false });
    expect(friendRequestFailure("federation_disabled").message).toMatch(/doesn't connect to other servers/);
    expect(friendRequestFailure("federation_domain_blocked").message).toMatch(/doesn't connect to that server/);
  });

  it("is a plain failure for anything else, however the answer was shaped", () => {
    for (const code of ["internal_error", "", undefined, "nonsense"]) {
      expect(friendRequestFailure(code)).toEqual({ message: "Couldn't send request.", settled: false });
    }
  });
});
