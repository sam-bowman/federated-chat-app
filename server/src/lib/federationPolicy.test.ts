import { describe, expect, it } from "vitest";
import { createDomainPolicy, describePolicy, normalizeDomain, parseDomainList } from "./federationPolicy.js";

describe("parseDomainList", () => {
  it("is empty when unset or blank, which means no limit", () => {
    expect(parseDomainList("X", undefined)).toEqual([]);
    expect(parseDomainList("X", "")).toEqual([]);
    expect(parseDomainList("X", "   ")).toEqual([]);
    expect(parseDomainList("X", " , ,")).toEqual([]);
  });

  it("reads comma-separated domains, ignoring case, spaces, a trailing comma and repeats", () => {
    expect(parseDomainList("X", " Chat.Example.com , other.example,chat.example.com,")).toEqual(["chat.example.com", "other.example"]);
  });

  it("accepts a port, and a fully-qualified name's trailing dot", () => {
    expect(parseDomainList("X", "localhost:4001,chat.example.com.")).toEqual(["localhost:4001", "chat.example.com"]);
  });

  it("refuses a wildcard, saying why, rather than treating it as an ordinary name", () => {
    expect(() => parseDomainList("FEDERATION_ALLOWED_DOMAINS", "*.example.com")).toThrow(/FEDERATION_ALLOWED_DOMAINS.*"\*\.example\.com".*wildcards/);
  });

  it.each(["https://chat.example.com", "chat.example.com/path", "chat example.com", "chat..example.com", "-bad.example", "bad-.example", "a_b.example", "chat.example.com:99999x", "@alice:chat.example.com"])(
    "refuses %s, naming the variable and the entry",
    (entry) => {
      const parse = () => parseDomainList("FEDERATION_BLOCKED_DOMAINS", `ok.example, ${entry}`);
      expect(parse).toThrow("FEDERATION_BLOCKED_DOMAINS");
      expect(parse).toThrow(`"${entry}"`);
    }
  );

  it("refuses one bad entry among good ones, rather than dropping it and carrying on", () => {
    expect(() => parseDomainList("X", "good.example,not a domain")).toThrow();
  });
});

describe("createDomainPolicy", () => {
  it("permits every domain when neither list is set", () => {
    const policy = createDomainPolicy([], []);
    expect(policy.isPermitted("anywhere.example")).toBe(true);
  });

  it("with an allow list, permits those and no others", () => {
    const policy = createDomainPolicy(["family.example", "club.example:8443"], []);
    expect(policy.isPermitted("family.example")).toBe(true);
    expect(policy.isPermitted("club.example:8443")).toBe(true);
    expect(policy.isPermitted("club.example")).toBe(false); // another port is another server
    expect(policy.isPermitted("stranger.example")).toBe(false);
  });

  it("with a block list, permits every domain but those", () => {
    const policy = createDomainPolicy([], ["spam.example"]);
    expect(policy.isPermitted("spam.example")).toBe(false);
    expect(policy.isPermitted("friend.example")).toBe(true);
  });

  it("does not care about case or a trailing dot when it compares", () => {
    const policy = createDomainPolicy(["Family.Example"], []);
    expect(policy.isPermitted("FAMILY.example.")).toBe(true);
    expect(createDomainPolicy([], ["Spam.Example"]).isPermitted("spam.example")).toBe(false);
  });

  it("lets a block list take away from an allow list", () => {
    const policy = createDomainPolicy(["a.example", "b.example"], ["c.example"]);
    expect(policy.isPermitted("a.example")).toBe(true);
    expect(policy.isPermitted("c.example")).toBe(false);
  });

  it("refuses a domain in both lists, naming it, instead of letting one quietly win", () => {
    expect(() => createDomainPolicy(["a.example", "b.example"], ["B.example"])).toThrow(/both list "b\.example"/);
  });
});

describe("normalizeDomain", () => {
  it("lower-cases and drops a trailing dot before a port or at the end", () => {
    expect(normalizeDomain(" Chat.Example. ")).toBe("chat.example");
    expect(normalizeDomain("chat.example.:8443")).toBe("chat.example:8443");
  });
});

describe("describePolicy", () => {
  it("says nothing when there is no limit", () => {
    expect(describePolicy(createDomainPolicy([], []))).toBeNull();
  });
  it("says which servers it talks to", () => {
    expect(describePolicy(createDomainPolicy(["a.example"], []))).toBe("only talks to: a.example");
    expect(describePolicy(createDomainPolicy([], ["b.example"]))).toBe("talks to every server except: b.example");
  });
});
