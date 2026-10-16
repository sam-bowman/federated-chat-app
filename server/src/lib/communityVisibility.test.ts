import { describe, expect, it } from "vitest";
import {
  COMMUNITY_VISIBILITIES,
  acceptsOtherServers,
  isCommunityVisibility,
  joinsWithoutInvite,
  openJoinOf,
  visibilityFromOpenJoin,
} from "./communityVisibility.js";

describe("what each visibility means", () => {
  it("lets a person with only the id join under UNLISTED and LOCAL_ONLY, but not INVITE_ONLY", () => {
    expect(joinsWithoutInvite("UNLISTED")).toBe(true);
    expect(joinsWithoutInvite("LOCAL_ONLY")).toBe(true);
    expect(joinsWithoutInvite("INVITE_ONLY")).toBe(false);
  });

  it("accepts people on other servers except under LOCAL_ONLY", () => {
    expect(acceptsOtherServers("UNLISTED")).toBe(true);
    expect(acceptsOtherServers("INVITE_ONLY")).toBe(true); // with an invite
    expect(acceptsOtherServers("LOCAL_ONLY")).toBe(false);
  });

  it("is the old yes/no for anything that still reads it", () => {
    expect(COMMUNITY_VISIBILITIES.map(openJoinOf)).toEqual([true, false, true]);
  });
});

describe("a community with only the old yes/no", () => {
  it("is invite-only when it said no, and unlisted when it said yes or said nothing (a server from before invites)", () => {
    expect(visibilityFromOpenJoin(false)).toBe("INVITE_ONLY");
    expect(visibilityFromOpenJoin(true)).toBe("UNLISTED");
    expect(visibilityFromOpenJoin(undefined)).toBe("UNLISTED");
  });
});

describe("isCommunityVisibility", () => {
  it("accepts exactly the names", () => {
    for (const v of COMMUNITY_VISIBILITIES) expect(isCommunityVisibility(v)).toBe(true);
    for (const v of ["PUBLIC", "unlisted", "", null, undefined, true, 1]) expect(isCommunityVisibility(v)).toBe(false);
  });
});
