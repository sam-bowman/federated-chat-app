import type { AdminSetting } from "../api";
import { settingValueInWords } from "./adminOverview";

// What the admin page's Settings tab says, in words (#206, phase 4): each setting by name, what it does, and how its values read. The server sends the
// names of the environment variables and the values as stored; a test checks every setting it can send has words here. Kept apart from the component so
// each rule can be tested on its own.

export interface SettingText {
  label: string;
  /** One or two sentences: what it does, and what changes for people when it is changed. */
  help: string;
  /** How each value reads in the choice box. Booleans use "true" and "false". A value with no entry is shown as it came. */
  options?: Record<string, string>;
}

const ON_OFF = { true: "On", false: "Off" };

export const SETTING_TEXT: Record<string, SettingText> = {
  SERVER_NAME: {
    label: "Server name",
    help: "What this server calls itself: shown on the sign-in page and to other servers. Up to 60 characters.",
  },
  LINK_PREVIEWS_ENABLED: {
    label: "Link previews",
    help: "Show a small card (title, description, site) under a message that links to a web page. The server reads the page, so it makes requests to addresses people type.",
    options: ON_OFF,
  },
  LINK_PREVIEW_IMAGES_ENABLED: {
    label: "Pictures in link previews",
    help: "Also keep a copy of the page's picture on this server and show it on the card (and show a link that is itself a picture). Needs link previews on. The server downloads and stores pictures from other people's sites.",
    options: ON_OFF,
  },
  REGISTRATION_ENABLED: {
    label: "Registration",
    help: "Whether anyone can make an account here. Off, nobody can, with or without an invite code.",
    options: { true: "Open", false: "Closed" },
  },
  REGISTRATION_INVITE_ONLY: {
    label: "Invite codes",
    help: "Ask for an invite code before an account is made. Only matters while registration is open. Make codes on the Invites tab.",
    options: { true: "Needed", false: "Not needed" },
  },
  FEDERATION_ENABLED: {
    label: "Talk to other servers",
    help: "Off makes this server private: it answers no other server, sends nothing, and starts nothing with anyone elsewhere. What already exists is kept and carries on when this is turned back on.",
    options: { true: "On", false: "Off: private" },
  },
  FEDERATION_ALLOWED_DOMAINS: {
    label: "Only talk to these servers",
    help: "One server per line, as it appears after the colon in a username (chat.example.com, or chat.example.com:8443). Empty: no limit. When there are any, every other server is left out.",
  },
  FEDERATION_BLOCKED_DOMAINS: {
    label: "Never talk to these servers",
    help: "One server per line. A server cannot be on both lists.",
  },
  FEDERATION_USER_DISCOVERABILITY: {
    label: "Whether people can be found by other servers",
    help: "A server with nothing to do with a person is told they do not exist when they are hidden. People can only narrow this for themselves, never widen it.",
  },
  DIRECTORY_ENABLED: {
    label: "Directory",
    help: "Publish a directory of this server's public communities and the people who chose to be listed, for others to browse.",
    options: { true: "Published", false: "Not published" },
  },
  DIRECTORY_PEOPLE: {
    label: "Whether people are listed in the directory",
    help: "Only matters while the directory is published. People can only narrow this for themselves.",
  },
  FEDERATION_CONTACT_POLICY_DEFAULT: {
    label: "Who may start something with a new account",
    help: "What new accounts start with. Existing accounts keep their own choice.",
  },
  FEDERATION_CONTACT_POLICY_LIMIT: {
    label: "The widest anyone may allow",
    help: "A person can choose something narrower than this but not wider. Taking the limit away brings their own choice back.",
  },
  COMMUNITY_VISIBILITY_DEFAULT: {
    label: "Who can join a new community",
    help: "What new communities start with. Existing communities keep their own choice. Until it is set, it is unlisted, or the limit if that is narrower.",
  },
  COMMUNITY_VISIBILITY_LIMIT: {
    label: "The most open a community may be",
    help: "A community can choose something narrower than this but not wider. Taking the limit away brings its own choice back.",
  },
};

/** The groups, in the order the page lists them. */
export const SETTING_GROUPS: { id: AdminSetting["group"]; title: string }[] = [
  { id: "server", title: "This server" },
  { id: "registration", title: "Registration" },
  { id: "federation", title: "Other servers" },
  { id: "people", title: "People" },
  { id: "communities", title: "Communities" },
];

/** What a value reads as. Anything this has no words for is shown as it came, so nothing is hidden by a missing rule. */
export function valueLabel(setting: AdminSetting, value: string): string {
  const own = SETTING_TEXT[setting.key]?.options?.[value];
  if (own) return own;
  if (setting.kind === "domains") return value === "" ? "None" : value.split(",").join(", ");
  return settingValueInWords(setting.key, value);
}

/** A list as the box shows it: one server per line. */
export const domainsToLines = (value: string): string => value.split(",").filter(Boolean).join("\n");

/** What the box holds as it would be stored: the same list however it was typed (lines or commas, spaces, repeats are the server's to tidy). */
export function draftToValue(setting: AdminSetting, draft: string): string {
  return setting.kind === "domains" ? draft.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean).join(",") : draft.trim();
}

/** Whether the box differs from what is in effect (so there is something to save). A list is compared in lower case, as the server keeps it. */
export function isDirty(setting: AdminSetting, draft: string): boolean {
  const typed = draftToValue(setting, draft).toLowerCase();
  return setting.kind === "domains" ? typed !== setting.value.toLowerCase() : draftToValue(setting, draft) !== setting.value;
}

/** Where the value comes from, in words. */
export function sourceWords(setting: AdminSetting): string {
  if (setting.source === "environment") return "Set by the server's environment";
  if (setting.source === "database") return "Changed here";
  return "Default";
}
