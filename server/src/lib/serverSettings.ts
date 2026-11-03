import { CONTACT_POLICIES, parseContactPolicySetting } from "./contactPolicy.js";
import { COMMUNITY_VISIBILITIES, checkVisibilityDefault, effectiveVisibility, parseVisibilitySetting, type CommunityVisibility } from "./communityVisibility.js";
import { parseDirectoryEnabled } from "./directorySetting.js";
import { parseDirectoryPeople } from "./directoryPeople.js";
import { parseFederationEnabled } from "./federationEnabled.js";
import { createDomainPolicy, parseDomainList } from "./federationPolicy.js";
import { parseLinkPreviewsEnabled } from "./linkPreview/setting.js";
import { parseRegistrationInviteOnly } from "./registrationInviteOnly.js";
import { parseUserDiscoverability } from "./userDiscoverability.js";

// The settings an operator can change from the admin page instead of the environment (#206, phase 4): which ones, what each accepts, and what each
// is when nobody has said. Pure: no config and no database, so it can be unit-tested on its own (modules/settings/service.ts is what reads and writes).
//
// THE RULE for where a value comes from, strongest first: the ENVIRONMENT (a variable that is set and not empty: the operator who wrote it in Helm or
// compose meant it, and a redeploy would silently undo a change made in a page, so the page shows it locked), then what the PAGE stored, then the
// DEFAULT. Every value is parsed by the SAME strict parser the environment variable has, so a typo is refused with the words it gets at startup:
// a setting that turns something off must never be misread.
//
// Never here, on purpose: secrets, the server's domain (it is part of every id), the storage driver, the trusted proxy and CORS list, rate limits
// (a wrong one could lock the operator out of the page itself), and ADMIN_ENABLED (the page cannot be what switches the page off).

export type SettingGroup = "server" | "registration" | "federation" | "people" | "communities";
export type SettingKind = "boolean" | "choice" | "text" | "domains";

export interface SettingDefinition {
  /** The name of the environment variable it stands in for, which is also its key in the database. */
  key: string;
  group: SettingGroup;
  kind: SettingKind;
  /** For `choice`: the values on offer, in the form they are stored. */
  choices?: readonly string[];
  /** The text the strict parser makes of `raw`, in the form it is stored and compared in. Throws an Error saying what is wrong. */
  canonical(raw: string): string;
  /** What it is when nobody has said. Null: it follows another setting (see `defaultOf`). */
  default: string | null;
}

const bool = (parse: (raw: string | undefined) => boolean) => (raw: string) => String(parse(raw));

const YES = new Set(["true", "1", "yes", "on"]);
const NO = new Set(["false", "0", "no", "off"]);
/** REGISTRATION_ENABLED has always been read leniently from the environment; what the page stores is held to the strict spellings. */
function parseStrictBoolean(name: string, raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (YES.has(value)) return true;
  if (NO.has(value)) return false;
  throw new Error(`${name} is "${raw}", which is not true or false.`);
}

export const MAX_SERVER_NAME_LENGTH = 60;
// Control, format and separator characters (bidi overrides, zero-width): the name is shown to everyone who reaches the server.
const HIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function parseServerName(raw: string): string {
  const name = raw.trim();
  if (name === "") throw new Error("SERVER_NAME cannot be empty.");
  if (name.length > MAX_SERVER_NAME_LENGTH) throw new Error(`SERVER_NAME is longer than ${MAX_SERVER_NAME_LENGTH} characters.`);
  if (HIDDEN_CHARACTERS.test(name)) throw new Error("SERVER_NAME has a character that cannot be seen (a control or invisible character).");
  return name;
}

/** One entry per line or separated by commas, as the page offers it; stored as the parser's own comma-separated, lower-case, de-duplicated form. */
const domains = (key: string) => (raw: string) => parseDomainList(key, raw.replace(/[\r\n]+/g, ",")).join(",");

function choiceSetting(
  key: string,
  group: SettingGroup,
  choices: readonly string[],
  canonical: (raw: string) => string,
  defaultValue: string | null
): SettingDefinition {
  return { key, group, kind: "choice", choices, canonical, default: defaultValue };
}

export const SETTINGS: readonly SettingDefinition[] = [
  { key: "SERVER_NAME", group: "server", kind: "text", canonical: parseServerName, default: "My Chat Server" },
  { key: "LINK_PREVIEWS_ENABLED", group: "server", kind: "boolean", canonical: bool(parseLinkPreviewsEnabled), default: "false" },

  { key: "REGISTRATION_ENABLED", group: "registration", kind: "boolean", canonical: (raw) => String(parseStrictBoolean("REGISTRATION_ENABLED", raw)), default: "true" },
  { key: "REGISTRATION_INVITE_ONLY", group: "registration", kind: "boolean", canonical: bool(parseRegistrationInviteOnly), default: "false" },

  { key: "FEDERATION_ENABLED", group: "federation", kind: "boolean", canonical: bool(parseFederationEnabled), default: "true" },
  { key: "FEDERATION_ALLOWED_DOMAINS", group: "federation", kind: "domains", canonical: domains("FEDERATION_ALLOWED_DOMAINS"), default: "" },
  { key: "FEDERATION_BLOCKED_DOMAINS", group: "federation", kind: "domains", canonical: domains("FEDERATION_BLOCKED_DOMAINS"), default: "" },
  choiceSetting("FEDERATION_USER_DISCOVERABILITY", "federation", ["default-on", "default-off", "forced-off"], (raw) => parseUserDiscoverability(raw), "default-on"),
  { key: "DIRECTORY_ENABLED", group: "federation", kind: "boolean", canonical: bool(parseDirectoryEnabled), default: "false" },

  choiceSetting("DIRECTORY_PEOPLE", "people", ["default-off", "default-on", "forced-off"], (raw) => parseDirectoryPeople(raw), "default-off"),
  choiceSetting("FEDERATION_CONTACT_POLICY_DEFAULT", "people", CONTACT_POLICIES, (raw) => parseContactPolicySetting("FEDERATION_CONTACT_POLICY_DEFAULT", raw, "ANYONE"), "ANYONE"),
  choiceSetting("FEDERATION_CONTACT_POLICY_LIMIT", "people", CONTACT_POLICIES, (raw) => parseContactPolicySetting("FEDERATION_CONTACT_POLICY_LIMIT", raw, "ANYONE"), "ANYONE"),

  // New communities start unlisted, or where the limit stops, whichever is narrower: the default follows the limit (see defaultOf).
  choiceSetting("COMMUNITY_VISIBILITY_DEFAULT", "communities", COMMUNITY_VISIBILITIES, (raw) => parseVisibilitySetting("COMMUNITY_VISIBILITY_DEFAULT", raw, "UNLISTED"), null),
  choiceSetting("COMMUNITY_VISIBILITY_LIMIT", "communities", COMMUNITY_VISIBILITIES, (raw) => parseVisibilitySetting("COMMUNITY_VISIBILITY_LIMIT", raw, "PUBLIC"), "PUBLIC"),
];

export const SETTING_KEYS: readonly string[] = SETTINGS.map((s) => s.key);

export function findSetting(key: string): SettingDefinition | undefined {
  return SETTINGS.find((s) => s.key === key);
}

/** What a setting is when nobody has said, given the values the others have (only the community default depends on another). */
export function defaultOf(definition: SettingDefinition, values: Readonly<Record<string, string>>): string {
  if (definition.default !== null) return definition.default;
  return effectiveVisibility("UNLISTED", (values.COMMUNITY_VISIBILITY_LIMIT ?? "PUBLIC") as CommunityVisibility);
}

/**
 * Whether the values can all hold at once: the two federation lists must not name the same server, and a new community must not start
 * somewhere wider than anyone may be. Returns what is wrong in words, or null. The same checks the environment gets at startup.
 */
export function combinationProblem(values: Readonly<Record<string, string>>): string | null {
  try {
    const list = (key: string) => (values[key] ?? "").split(",").filter((entry) => entry !== "");
    createDomainPolicy(list("FEDERATION_ALLOWED_DOMAINS"), list("FEDERATION_BLOCKED_DOMAINS"));
    checkVisibilityDefault(values.COMMUNITY_VISIBILITY_DEFAULT as CommunityVisibility, values.COMMUNITY_VISIBILITY_LIMIT as CommunityVisibility);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Whether the environment has said anything about a variable: set, and not just blank (a compose file passes `${X:-}` for "not set"). */
export function isSetInEnvironment(raw: string | undefined): boolean {
  return raw !== undefined && raw.trim() !== "";
}
