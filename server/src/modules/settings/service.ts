import { config, settingsEnvironment } from "../../config.js";
import { prisma } from "../../db.js";
import { createDomainPolicy, parseDomainList } from "../../lib/federationPolicy.js";
import type { CommunityVisibility } from "../../lib/communityVisibility.js";
import type { ContactPolicy } from "../../lib/contactPolicy.js";
import type { DirectoryPeopleMode } from "../../lib/directoryPeople.js";
import type { UserDiscoverability } from "../../lib/userDiscoverability.js";
import {
  SETTINGS,
  combinationProblem,
  defaultOf,
  findSetting,
  isSetInEnvironment,
  type SettingDefinition,
  type SettingGroup,
  type SettingKind,
} from "../../lib/serverSettings.js";
import { recordAudit } from "../audit/service.js";
import { CLI_CONTEXT, type AdminContext } from "../admin/service.js";

// The settings layer (#206, phase 4): the strict, shared definitions are in lib/serverSettings.ts; this is where they meet `config` and the database.
//
// A value comes from the ENVIRONMENT if the variable is set and not blank (then it is locked: the page shows it and cannot change it), else from the
// row the page stored in ServerSetting, else the default. `config` is changed IN PLACE, because everything that reads a setting reads `config.x` at the
// moment it decides (that was checked for each of these, and is why they take effect without a restart). Other replicas see a change within
// SYNC_INTERVAL_MS, when they read the table again; the replica that made it applies it at once.

/** How often a replica reads the table to pick up what another one stored. */
export const SYNC_INTERVAL_MS = 15_000;

export type SettingSource = "environment" | "database" | "default";

export interface SettingView {
  key: string;
  group: SettingGroup;
  kind: SettingKind;
  choices: string[] | null;
  /** What is in effect on this replica now, in the stored form (a list is comma-separated). */
  value: string;
  source: SettingSource;
  /** Set in the environment: shown, not changeable. */
  locked: boolean;
  /** What it is when nobody says anything. */
  default: string;
  updatedAt: string | null;
  /** The page's stored value was refused when it was read (it no longer parses), so it is not in effect. Words for the operator. */
  problem: string | null;
}

export type SettingErrorCode = "unknown_setting" | "locked_by_environment" | "invalid_value" | "conflicts_with_another_setting";

export class SettingError extends Error {
  constructor(
    readonly code: SettingErrorCode,
    message: string
  ) {
    super(message);
  }
}

interface Accessor {
  get(): string;
  set(value: string): void;
}

const list = (value: string): string[] => value.split(",").filter((entry) => entry !== "");

// Where each setting lives in `config`. A list rebuilds the whole policy from both lists, since the policy object holds the pair.
const ACCESS: Record<string, Accessor> = {
  SERVER_NAME: { get: () => config.serverName, set: (v) => (config.serverName = v) },
  LINK_PREVIEWS_ENABLED: { get: () => String(config.linkPreviewsEnabled), set: (v) => (config.linkPreviewsEnabled = v === "true") },
  REGISTRATION_ENABLED: { get: () => String(config.registrationEnabled), set: (v) => (config.registrationEnabled = v === "true") },
  REGISTRATION_INVITE_ONLY: { get: () => String(config.registrationInviteOnly), set: (v) => (config.registrationInviteOnly = v === "true") },
  FEDERATION_ENABLED: { get: () => String(config.federationEnabled), set: (v) => (config.federationEnabled = v === "true") },
  FEDERATION_ALLOWED_DOMAINS: {
    get: () => config.federationPolicy.allowed.join(","),
    set: (v) => (config.federationPolicy = createDomainPolicy(parseDomainList("FEDERATION_ALLOWED_DOMAINS", v), config.federationPolicy.blocked)),
  },
  FEDERATION_BLOCKED_DOMAINS: {
    get: () => config.federationPolicy.blocked.join(","),
    set: (v) => (config.federationPolicy = createDomainPolicy(config.federationPolicy.allowed, parseDomainList("FEDERATION_BLOCKED_DOMAINS", v))),
  },
  FEDERATION_USER_DISCOVERABILITY: { get: () => config.userDiscoverability, set: (v) => (config.userDiscoverability = v as UserDiscoverability) },
  DIRECTORY_ENABLED: { get: () => String(config.directoryEnabled), set: (v) => (config.directoryEnabled = v === "true") },
  DIRECTORY_PEOPLE: { get: () => config.directoryPeople, set: (v) => (config.directoryPeople = v as DirectoryPeopleMode) },
  FEDERATION_CONTACT_POLICY_DEFAULT: { get: () => config.contactPolicyDefault, set: (v) => (config.contactPolicyDefault = v as ContactPolicy) },
  FEDERATION_CONTACT_POLICY_LIMIT: { get: () => config.contactPolicyLimit, set: (v) => (config.contactPolicyLimit = v as ContactPolicy) },
  COMMUNITY_VISIBILITY_DEFAULT: { get: () => config.communityVisibilityDefault, set: (v) => (config.communityVisibilityDefault = v as CommunityVisibility) },
  COMMUNITY_VISIBILITY_LIMIT: { get: () => config.communityVisibilityLimit, set: (v) => (config.communityVisibilityLimit = v as CommunityVisibility) },
};

/** What the page stored, as this replica last read it. */
const stored = new Map<string, { value: string; updatedAt: Date }>();
/** Stored values that could not be used, with why. */
const refused = new Map<string, string>();
let warnings: string[] = [];
/** What was last said in the log, so the timer (every 15 s) does not repeat a problem that has not changed. */
const said = new Set<string>();
function sayOnce(line: string): void {
  if (said.has(line)) return;
  said.add(line);
  console.error("[settings] %s", line);
}

const locked = (key: string) => isSetInEnvironment(settingsEnvironment[key]);

function currentValues(): Record<string, string> {
  return Object.fromEntries(SETTINGS.map((s) => [s.key, ACCESS[s.key].get()]));
}

/** The values the settings would have if `rows` were applied, the environment's staying as they are, and which of the rows could not be used. */
function plan(rows: ReadonlyMap<string, { value: string }>): { values: Record<string, string>; refusedNow: Map<string, string> } {
  const values = currentValues();
  const refusedNow = new Map<string, string>();
  const usable: SettingDefinition[] = [];
  for (const definition of SETTINGS) {
    if (locked(definition.key)) continue;
    const row = rows.get(definition.key);
    if (row) {
      try {
        values[definition.key] = definition.canonical(row.value);
        continue;
      } catch (err) {
        refusedNow.set(definition.key, err instanceof Error ? err.message : String(err));
      }
    }
    usable.push(definition);
  }
  // What is left is at its default; one default depends on another value, so they come after the rest.
  for (const definition of usable.filter((d) => d.default !== null)) values[definition.key] = definition.default as string;
  for (const definition of usable.filter((d) => d.default === null)) values[definition.key] = defaultOf(definition, values);
  return { values, refusedNow };
}

/** Applies what is stored to `config`. Idempotent. A set of values that cannot all hold is not applied at all, and said so in the warnings. */
function applyStored(): void {
  const { values, refusedNow } = plan(stored);
  const problem = combinationProblem(values);
  refused.clear();
  for (const [key, why] of refusedNow) {
    refused.set(key, why);
    sayOnce(`the stored value of ${key} is not valid and is ignored: ${why}`);
  }
  if (problem) {
    warnings = [`The stored settings cannot all hold at once, so none of the changes made in the page apply until this is fixed: ${problem}`];
    sayOnce(warnings[0]);
    return;
  }
  warnings = [];
  // The two lists are applied together: one at a time could pass through a pair that overlaps.
  config.federationPolicy = createDomainPolicy(list(values.FEDERATION_ALLOWED_DOMAINS), list(values.FEDERATION_BLOCKED_DOMAINS));
  for (const definition of SETTINGS) {
    if (locked(definition.key) || definition.kind === "domains") continue;
    ACCESS[definition.key].set(values[definition.key]);
  }
}

/** Reads the table and applies it. At startup, in the admin command, on the timer, and before the page lists the settings. */
export async function loadServerSettings(): Promise<void> {
  const rows = await prisma.serverSetting.findMany();
  stored.clear();
  for (const row of rows) stored.set(row.key, { value: row.value, updatedAt: row.updatedAt });
  applyStored();
}

/** Keeps this replica in step with the others. The timer does not keep the process alive. */
export function startServerSettingsSync(intervalMs: number = SYNC_INTERVAL_MS): () => void {
  const timer = setInterval(() => {
    loadServerSettings().catch((err) => console.error("[settings] could not read the stored settings:", err));
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

function view(definition: SettingDefinition): SettingView {
  const values = currentValues();
  const row = stored.get(definition.key);
  const isLocked = locked(definition.key);
  const source: SettingSource = isLocked ? "environment" : row && !refused.has(definition.key) ? "database" : "default";
  return {
    key: definition.key,
    group: definition.group,
    kind: definition.kind,
    choices: definition.choices ? [...definition.choices] : null,
    value: values[definition.key],
    source,
    locked: isLocked,
    default: defaultOf(definition, values),
    updatedAt: source === "database" && row ? row.updatedAt.toISOString() : null,
    problem: refused.get(definition.key) ?? null,
  };
}

/** Every setting, as in effect on this replica now (the table is read first, so a change made on another replica shows). */
export async function listSettings(): Promise<{ settings: SettingView[]; warnings: string[] }> {
  await loadServerSettings();
  return { settings: SETTINGS.map(view), warnings };
}

function definitionOf(key: string): SettingDefinition {
  const definition = findSetting(key);
  if (!definition) throw new SettingError("unknown_setting", `There is no setting called ${key}.`);
  if (locked(key)) {
    throw new SettingError("locked_by_environment", `${key} is set in the server's environment, so it cannot be changed here. Change it where the server is deployed.`);
  }
  return definition;
}

// A list is recorded by how many servers it names, not by the names: they can be long, and the entries are not what the log is for.
function auditDetails(definition: SettingDefinition, from: string, to: string): Record<string, unknown> {
  const servers = (value: string) => `${list(value).length} server${list(value).length === 1 ? "" : "s"}`;
  return definition.kind === "domains" ? { from: servers(from), to: servers(to) } : { from, to };
}

/** Stores a new value and applies it. Throws a SettingError for an unknown or locked setting, a value the strict parser refuses, or a clash with another setting. */
export async function setSetting(key: string, raw: string, ctx: AdminContext = CLI_CONTEXT): Promise<SettingView> {
  const definition = definitionOf(key);
  await loadServerSettings();
  let value: string;
  try {
    if (definition.kind !== "domains" && raw.trim() === "") throw new Error(`${key} cannot be empty.`);
    value = definition.canonical(raw);
  } catch (err) {
    throw new SettingError("invalid_value", err instanceof Error ? err.message : String(err));
  }
  const before = ACCESS[key].get();
  const planned = new Map<string, { value: string }>(stored);
  planned.set(key, { value });
  const { values } = plan(planned);
  const problem = combinationProblem(values);
  if (problem) throw new SettingError("conflicts_with_another_setting", problem);

  const unchanged = stored.get(key)?.value === value;
  const row = await prisma.serverSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  stored.set(key, { value: row.value, updatedAt: row.updatedAt });
  applyStored();
  if (!unchanged) await recordAudit({ source: ctx.source, action: "setting.change", actor: ctx.actor, target: { type: "setting", id: key, label: key }, details: auditDetails(definition, before, value) });
  return view(definition);
}

/** Takes the page's value away, so the setting is at its default again. Nothing to do (and nothing recorded) when the page had stored nothing. */
export async function resetSetting(key: string, ctx: AdminContext = CLI_CONTEXT): Promise<SettingView> {
  const definition = definitionOf(key);
  await loadServerSettings();
  const had = stored.has(key);
  if (!had) return view(definition);
  // No check against the other settings: going back to a default never clashes (a limit goes up to PUBLIC, a default follows the limit, a list empties).
  const before = ACCESS[key].get();
  await prisma.serverSetting.deleteMany({ where: { key } });
  stored.delete(key);
  applyStored();
  await recordAudit({
    source: ctx.source,
    action: "setting.change",
    actor: ctx.actor,
    target: { type: "setting", id: key, label: key },
    details: auditDetails(definition, before, ACCESS[key].get()),
  });
  return view(definition);
}
