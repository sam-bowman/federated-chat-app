import { describe, expect, it } from "vitest";
import {
  COMMUNITY_VISIBILITIES,
  acceptsOtherServers,
  checkVisibilityDefault,
  effectiveVisibility,
  isWiderThan,
  parseVisibilitySetting,
  isCommunityVisibility,
  joinsWithoutInvite,
  openJoinOf,
  visibilityFromOpenJoin,
} from "./communityVisibility.js";

describe("what each visibility means", () => {
  it("lets a person with only the id join under UNLISTED, PUBLIC and LOCAL_ONLY, but not INVITE_ONLY", () => {
    expect(joinsWithoutInvite("UNLISTED")).toBe(true);
    expect(joinsWithoutInvite("PUBLIC")).toBe(true);
    expect(joinsWithoutInvite("LOCAL_ONLY")).toBe(true);
    expect(joinsWithoutInvite("INVITE_ONLY")).toBe(false);
  });

  it("accepts people on other servers except under LOCAL_ONLY", () => {
    expect(acceptsOtherServers("UNLISTED")).toBe(true);
    expect(acceptsOtherServers("PUBLIC")).toBe(true);
    expect(acceptsOtherServers("INVITE_ONLY")).toBe(true); // with an invite
    expect(acceptsOtherServers("LOCAL_ONLY")).toBe(false);
  });

  it("is the old yes/no for anything that still reads it", () => {
    expect(COMMUNITY_VISIBILITIES.map(openJoinOf)).toEqual([true, false, true, true]);
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
    for (const v of ["SECRET", "unlisted", "public", "", null, undefined, true, 1]) expect(isCommunityVisibility(v)).toBe(false);
  });
});

describe("how exposed each kind is, and a server's limit on it", () => {
  const order = ["LOCAL_ONLY", "INVITE_ONLY", "UNLISTED", "PUBLIC"] as const;

  it("orders the kinds from closed to other servers to listed", () => {
    for (let i = 0; i < order.length; i++) {
      for (let j = 0; j < order.length; j++) expect(isWiderThan(order[i], order[j])).toBe(i > j);
    }
  });

  it("leaves a community alone when it is within the limit, and holds one that is wider to the limit", () => {
    expect(effectiveVisibility("INVITE_ONLY", "PUBLIC")).toBe("INVITE_ONLY");
    expect(effectiveVisibility("UNLISTED", "UNLISTED")).toBe("UNLISTED");
    expect(effectiveVisibility("PUBLIC", "UNLISTED")).toBe("UNLISTED");
    expect(effectiveVisibility("PUBLIC", "LOCAL_ONLY")).toBe("LOCAL_ONLY");
    expect(effectiveVisibility("UNLISTED", "INVITE_ONLY")).toBe("INVITE_ONLY");
    expect(effectiveVisibility("LOCAL_ONLY", "INVITE_ONLY")).toBe("LOCAL_ONLY"); // narrower than the limit: kept
  });

  it("is no limit at all at PUBLIC", () => {
    for (const v of order) expect(effectiveVisibility(v, "PUBLIC")).toBe(v);
  });
});

describe("parseVisibilitySetting", () => {
  it("is the fallback when unset or blank, and reads a name in any case", () => {
    expect(parseVisibilitySetting("X", undefined, "UNLISTED")).toBe("UNLISTED");
    expect(parseVisibilitySetting("X", "", "PUBLIC")).toBe("PUBLIC");
    expect(parseVisibilitySetting("X", " invite-only ", "UNLISTED")).toBe("INVITE_ONLY");
    expect(parseVisibilitySetting("X", "local_only", "UNLISTED")).toBe("LOCAL_ONLY");
  });

  it.each(["private", "open", "public,unlisted", "0"])("refuses %s, naming the variable", (value) => {
    expect(() => parseVisibilitySetting("COMMUNITY_VISIBILITY_LIMIT", value, "PUBLIC")).toThrow(/COMMUNITY_VISIBILITY_LIMIT.*UNLISTED, INVITE_ONLY, LOCAL_ONLY, PUBLIC/);
  });
});

describe("checkVisibilityDefault", () => {
  it("accepts a default within the limit and refuses one wider than it", () => {
    expect(() => checkVisibilityDefault("UNLISTED", "PUBLIC")).not.toThrow();
    expect(() => checkVisibilityDefault("UNLISTED", "UNLISTED")).not.toThrow();
    expect(() => checkVisibilityDefault("LOCAL_ONLY", "INVITE_ONLY")).not.toThrow();
    expect(() => checkVisibilityDefault("PUBLIC", "UNLISTED")).toThrow(/COMMUNITY_VISIBILITY_DEFAULT is PUBLIC.*wider than COMMUNITY_VISIBILITY_LIMIT \(UNLISTED\)/);
  });
});
