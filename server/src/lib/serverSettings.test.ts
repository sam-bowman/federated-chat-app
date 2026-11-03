import { describe, expect, it } from "vitest";
import { parseContactPolicySetting } from "./contactPolicy.js";
import { parseDirectoryEnabled } from "./directorySetting.js";
import { parseDirectoryPeople } from "./directoryPeople.js";
import { parseFederationEnabled } from "./federationEnabled.js";
import { parseLinkPreviewImagesEnabled } from "./linkPreview/imageSetting.js";
import { parseLinkPreviewsEnabled } from "./linkPreview/setting.js";
import { parseRegistrationInviteOnly } from "./registrationInviteOnly.js";
import { SETTINGS, SETTING_KEYS, combinationProblem, defaultOf, findSetting, isSetInEnvironment } from "./serverSettings.js";
import { parseUserDiscoverability } from "./userDiscoverability.js";
import { parseVisibilitySetting } from "./communityVisibility.js";

const must = (key: string) => {
  const definition = findSetting(key);
  if (!definition) throw new Error(`no setting ${key}`);
  return definition;
};

describe("what the page may change (#206 phase 4)", () => {
  it("names each setting once, by an environment variable", () => {
    expect(new Set(SETTING_KEYS).size).toBe(SETTING_KEYS.length);
    for (const key of SETTING_KEYS) expect(key).toMatch(/^[A-Z][A-Z0-9_]+$/);
  });

  it("never offers a secret, the domain, storage, the proxy and CORS lists, rate limits, or the switch for the admin page itself", () => {
    // Changing these from a browser could lock the operator out of the page, or cannot be changed at all (the domain is part of every id).
    for (const key of SETTING_KEYS) {
      expect(key).not.toMatch(/SECRET|PASSWORD|TOKEN|KEY|_URL$|S3_|STORAGE|TRUST_PROXY|CORS|RATE_LIMIT|ADMIN_ENABLED|SERVER_DOMAIN|DATABASE/);
    }
  });

  it("has the same default as the strict parser of the variable gives an empty value (so a setting that is untouched changes nothing)", () => {
    const asked: Record<string, string> = {
      LINK_PREVIEWS_ENABLED: String(parseLinkPreviewsEnabled("")),
      LINK_PREVIEW_IMAGES_ENABLED: String(parseLinkPreviewImagesEnabled("")),
      REGISTRATION_INVITE_ONLY: String(parseRegistrationInviteOnly("")),
      FEDERATION_ENABLED: String(parseFederationEnabled("")),
      FEDERATION_USER_DISCOVERABILITY: parseUserDiscoverability(""),
      DIRECTORY_ENABLED: String(parseDirectoryEnabled("")),
      DIRECTORY_PEOPLE: parseDirectoryPeople(""),
      FEDERATION_CONTACT_POLICY_DEFAULT: parseContactPolicySetting("X", "", "ANYONE"),
      FEDERATION_CONTACT_POLICY_LIMIT: parseContactPolicySetting("X", "", "ANYONE"),
      COMMUNITY_VISIBILITY_LIMIT: parseVisibilitySetting("X", "", "PUBLIC"),
    };
    for (const [key, parsed] of Object.entries(asked)) expect(must(key).default, key).toBe(parsed);
    expect(must("REGISTRATION_ENABLED").default).toBe("true");
    expect(must("FEDERATION_ALLOWED_DOMAINS").default).toBe("");
    expect(must("FEDERATION_BLOCKED_DOMAINS").default).toBe("");
  });

  it("holds booleans to the strict spellings: a typo that could turn something off is refused, not guessed", () => {
    for (const key of ["REGISTRATION_ENABLED", "REGISTRATION_INVITE_ONLY", "FEDERATION_ENABLED", "DIRECTORY_ENABLED", "LINK_PREVIEWS_ENABLED", "LINK_PREVIEW_IMAGES_ENABLED"]) {
      expect(must(key).canonical("YES"), key).toBe("true");
      expect(must(key).canonical("off"), key).toBe("false");
      expect(() => must(key).canonical("fasle"), key).toThrow(/true or false|not true/);
    }
  });

  it("refuses a name that is not one of the choices, and stores the canonical spelling", () => {
    expect(must("FEDERATION_CONTACT_POLICY_LIMIT").canonical("local_only")).toBe("LOCAL_ONLY");
    expect(must("COMMUNITY_VISIBILITY_LIMIT").canonical("invite-only")).toBe("INVITE_ONLY");
    expect(must("FEDERATION_USER_DISCOVERABILITY").canonical("Forced-Off")).toBe("forced-off");
    expect(() => must("FEDERATION_USER_DISCOVERABILITY").canonical("forced")).toThrow(/not one of/);
    expect(() => must("DIRECTORY_PEOPLE").canonical("")).not.toThrow(); // the parser's own default: the service refuses a blank before it gets here
  });

  it("parses a list of servers from lines or commas, lower-case and without repeats, and refuses a wildcard or a URL", () => {
    const allowed = must("FEDERATION_ALLOWED_DOMAINS");
    expect(allowed.canonical("Chat.Example.com\r\nother.example.org:8443,\nchat.example.com")).toBe("chat.example.com,other.example.org:8443");
    expect(allowed.canonical("   ")).toBe("");
    expect(() => allowed.canonical("*.example.com")).toThrow(/wildcards/);
    expect(() => allowed.canonical("https://chat.example.com")).toThrow(/not a domain/);
  });

  it("keeps the server name to a short line of visible characters", () => {
    const name = must("SERVER_NAME");
    expect(name.canonical("  Our Place  ")).toBe("Our Place");
    expect(() => name.canonical("   ")).toThrow(/empty/);
    expect(() => name.canonical("x".repeat(61))).toThrow(/longer/);
    expect(() => name.canonical("two\nlines")).toThrow(/cannot be seen/);
    expect(() => name.canonical("evil‮name")).toThrow(/cannot be seen/);
    expect(() => name.canonical("zero​width")).toThrow(/cannot be seen/);
  });

  it("makes the community default follow the limit until it is set", () => {
    const def = must("COMMUNITY_VISIBILITY_DEFAULT");
    expect(defaultOf(def, { COMMUNITY_VISIBILITY_LIMIT: "PUBLIC" })).toBe("UNLISTED");
    expect(defaultOf(def, { COMMUNITY_VISIBILITY_LIMIT: "INVITE_ONLY" })).toBe("INVITE_ONLY");
    expect(defaultOf(def, { COMMUNITY_VISIBILITY_LIMIT: "LOCAL_ONLY" })).toBe("LOCAL_ONLY");
  });

  it("says when the values cannot all hold: a server both allowed and blocked, a community default wider than the limit", () => {
    const fine = { FEDERATION_ALLOWED_DOMAINS: "a.example.com", FEDERATION_BLOCKED_DOMAINS: "b.example.com", COMMUNITY_VISIBILITY_DEFAULT: "UNLISTED", COMMUNITY_VISIBILITY_LIMIT: "PUBLIC" };
    expect(combinationProblem(fine)).toBeNull();
    expect(combinationProblem({ ...fine, FEDERATION_BLOCKED_DOMAINS: "a.example.com" })).toMatch(/both list "a.example.com"/);
    expect(combinationProblem({ ...fine, COMMUNITY_VISIBILITY_DEFAULT: "PUBLIC", COMMUNITY_VISIBILITY_LIMIT: "INVITE_ONLY" })).toMatch(/wider than/);
  });

  it("counts a variable as set only when it says something", () => {
    expect(isSetInEnvironment(undefined)).toBe(false);
    expect(isSetInEnvironment("")).toBe(false);
    expect(isSetInEnvironment("   ")).toBe(false);
    expect(isSetInEnvironment("false")).toBe(true);
  });

  it("covers every definition above (no setting is missed by these checks)", () => {
    expect(SETTINGS.length).toBe(15);
  });
});
