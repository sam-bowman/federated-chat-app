import { describe, expect, it } from "vitest";
import {
  CONTACT_POLICIES,
  contactAllowed,
  contactAllowedUnderLimit,
  isContactPolicy,
  needsSharedCommunity,
  parseContactPolicySetting,
  type ContactFacts,
} from "./contactPolicy.js";

const facts = (over: Partial<ContactFacts> = {}): ContactFacts => ({ senderIsLocal: false, isFriend: false, sharesCommunity: false, ...over });

describe("contactAllowed", () => {
  it("lets anyone in under ANYONE", () => {
    expect(contactAllowed("ANYONE", facts())).toBe(true);
    expect(contactAllowed("ANYONE", facts({ senderIsLocal: true }))).toBe(true);
  });

  it("under SHARED_COMMUNITY, lets in only someone who shares a community, wherever they are", () => {
    expect(contactAllowed("SHARED_COMMUNITY", facts())).toBe(false);
    expect(contactAllowed("SHARED_COMMUNITY", facts({ senderIsLocal: true }))).toBe(false); // a stranger on this server is still a stranger
    expect(contactAllowed("SHARED_COMMUNITY", facts({ sharesCommunity: true }))).toBe(true);
    expect(contactAllowed("SHARED_COMMUNITY", facts({ senderIsLocal: true, sharesCommunity: true }))).toBe(true);
  });

  it("under LOCAL_ONLY, lets in only people on this server, whatever else they share", () => {
    expect(contactAllowed("LOCAL_ONLY", facts())).toBe(false);
    expect(contactAllowed("LOCAL_ONLY", facts({ sharesCommunity: true }))).toBe(false); // a shared community does not make them local
    expect(contactAllowed("LOCAL_ONLY", facts({ senderIsLocal: true }))).toBe(true);
  });

  it("always lets a friend in, whatever was chosen", () => {
    for (const policy of CONTACT_POLICIES) expect(contactAllowed(policy, facts({ isFriend: true }))).toBe(true);
  });
});

describe("isContactPolicy", () => {
  it("accepts exactly the three names", () => {
    for (const policy of CONTACT_POLICIES) expect(isContactPolicy(policy)).toBe(true);
    for (const value of ["anyone", "NOBODY", "", null, undefined, 1, {}]) expect(isContactPolicy(value)).toBe(false);
  });
});

describe("contactAllowedUnderLimit", () => {
  it("is the person's own choice when the server has no limit", () => {
    for (const policy of CONTACT_POLICIES) {
      for (const f of [facts(), facts({ senderIsLocal: true }), facts({ sharesCommunity: true })]) {
        expect(contactAllowedUnderLimit(policy, "ANYONE", f)).toBe(contactAllowed(policy, f));
      }
    }
  });

  it("lets in only people BOTH allow: the server can narrow what a person chose, never widen it", () => {
    // The server only lets local people in; the person would let in anyone: local people only.
    expect(contactAllowedUnderLimit("ANYONE", "LOCAL_ONLY", facts())).toBe(false);
    expect(contactAllowedUnderLimit("ANYONE", "LOCAL_ONLY", facts({ senderIsLocal: true }))).toBe(true);
    // The person only lets in people on this server, and the server only people who share a community: both.
    expect(contactAllowedUnderLimit("LOCAL_ONLY", "SHARED_COMMUNITY", facts({ senderIsLocal: true }))).toBe(false);
    expect(contactAllowedUnderLimit("LOCAL_ONLY", "SHARED_COMMUNITY", facts({ senderIsLocal: true, sharesCommunity: true }))).toBe(true);
    expect(contactAllowedUnderLimit("LOCAL_ONLY", "SHARED_COMMUNITY", facts({ sharesCommunity: true }))).toBe(false);
  });

  it("still lets a friend in, whatever either says", () => {
    for (const person of CONTACT_POLICIES) {
      for (const limit of CONTACT_POLICIES) expect(contactAllowedUnderLimit(person, limit, facts({ isFriend: true }))).toBe(true);
    }
  });
});

describe("needsSharedCommunity", () => {
  it("is true only when the person's choice or the server's limit looks at shared communities", () => {
    expect(needsSharedCommunity("SHARED_COMMUNITY", "ANYONE")).toBe(true);
    expect(needsSharedCommunity("ANYONE", "SHARED_COMMUNITY")).toBe(true);
    expect(needsSharedCommunity("ANYONE", "LOCAL_ONLY")).toBe(false);
    expect(needsSharedCommunity("LOCAL_ONLY", "ANYONE")).toBe(false);
  });
});

describe("parseContactPolicySetting", () => {
  it("is the fallback when unset or blank", () => {
    expect(parseContactPolicySetting("X", undefined, "ANYONE")).toBe("ANYONE");
    expect(parseContactPolicySetting("X", "  ", "LOCAL_ONLY")).toBe("LOCAL_ONLY");
  });

  it("reads a name in any case, with a dash for an underscore", () => {
    expect(parseContactPolicySetting("X", "shared_community", "ANYONE")).toBe("SHARED_COMMUNITY");
    expect(parseContactPolicySetting("X", " Local-Only ", "ANYONE")).toBe("LOCAL_ONLY");
  });

  it.each(["nobody", "anyone,local_only", "local", "1"])("refuses %s, naming the variable", (value) => {
    expect(() => parseContactPolicySetting("FEDERATION_CONTACT_POLICY_LIMIT", value, "ANYONE")).toThrow(/FEDERATION_CONTACT_POLICY_LIMIT.*ANYONE, SHARED_COMMUNITY, LOCAL_ONLY/);
  });
});
