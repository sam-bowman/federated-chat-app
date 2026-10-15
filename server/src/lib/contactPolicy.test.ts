import { describe, expect, it } from "vitest";
import { CONTACT_POLICIES, contactAllowed, isContactPolicy, type ContactFacts } from "./contactPolicy.js";

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
