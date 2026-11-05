import { cleanLine } from "./linkPreview/embed.js";

// Slash commands (#132, phase 3b, docs/commands-3b-plan.md): what a bot may register, and what a person's entries for a command must look like
// before the bot ever sees them. Both come from strangers (a bot's author, a person typing in a form), so each is checked here, strictly: a
// registration that is wrong is refused whole with the first thing wrong named, and options that do not fit the registered types are refused
// before any program is told. Kept free of config.ts imports so it can be unit-tested on its own.

export const COMMAND_LIMITS = {
  /** Commands one bot may have. */
  commands: 50,
  /** Options one command may have. */
  options: 10,
  /** Fixed choices one option may offer. */
  choices: 25,
  name: 32,
  description: 100,
  choiceName: 100,
  /** The longest text a person may enter for a `string` option. */
  string: 2000,
} as const;

export const OPTION_TYPES = ["string", "integer", "number", "boolean", "member", "channel"] as const;
export type OptionType = (typeof OPTION_TYPES)[number];

/** Lower-case letters, digits, `_` and `-`, starting with a letter or digit (so never `__proto__`): what a command or option is called. */
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** What a member's or a channel's id looks like (a protocol id): checked for shape here and for existence by the caller. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface CommandChoice {
  name: string;
  value: string | number;
}

export interface CommandOption {
  name: string;
  description: string;
  type: OptionType;
  required: boolean;
  choices?: CommandChoice[];
}

export interface CommandDef {
  name: string;
  description: string;
  options: CommandOption[];
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; detail: string };

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const fail = (detail: string): { ok: false; detail: string } => ({ ok: false, detail });
const count = (text: string) => [...text].length;

/** Text of one line, cleaned (controls and direction overrides removed), that must be there and may not be over `max` characters. Never cut for the author. */
function describe(value: unknown, max: number, what: string): Parsed<string> {
  if (typeof value !== "string") return fail(`${what} must be text`);
  if (value.length > max * 8) return fail(`${what} is longer than ${max} characters`);
  const cleaned = cleanLine(value, max + 1);
  if (cleaned === null) return fail(`${what} must not be empty`);
  if (count(cleaned) > max) return fail(`${what} is longer than ${max} characters`);
  return { ok: true, value: cleaned };
}

function parseChoices(raw: unknown, type: OptionType, where: string): Parsed<CommandChoice[] | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (type !== "string" && type !== "integer" && type !== "number") return fail(`${where}: only string, integer and number options may have choices`);
  if (!Array.isArray(raw) || raw.length === 0) return fail(`${where}: choices must be a list with at least one choice`);
  if (raw.length > COMMAND_LIMITS.choices) return fail(`${where}: at most ${COMMAND_LIMITS.choices} choices`);
  const out: CommandChoice[] = [];
  for (const [i, item] of raw.entries()) {
    if (!isRecord(item)) return fail(`${where}: choice ${i + 1} must be an object with a name and a value`);
    const name = describe(item.name, COMMAND_LIMITS.choiceName, `${where}: choice ${i + 1}'s name`);
    if (!name.ok) return name;
    const value = item.value;
    let good: string | number;
    if (type === "string") {
      const text = describe(value, COMMAND_LIMITS.string, `${where}: choice ${i + 1}'s value`);
      if (!text.ok) return text;
      good = text.value;
    } else if (type === "integer" && typeof value === "number" && Number.isSafeInteger(value)) good = value;
    else if (type === "number" && typeof value === "number" && Number.isFinite(value)) good = value;
    else return fail(`${where}: choice ${i + 1}'s value must be ${type === "integer" ? "a whole number" : "a number"}`);
    if (out.some((c) => c.value === good)) return fail(`${where}: two choices have the value ${JSON.stringify(good)}`);
    out.push({ name: name.value, value: good });
  }
  return { ok: true, value: out };
}

function parseOptions(raw: unknown, where: string): Parsed<CommandOption[]> {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return fail(`${where}: options must be a list`);
  if (raw.length > COMMAND_LIMITS.options) return fail(`${where}: at most ${COMMAND_LIMITS.options} options`);
  const out: CommandOption[] = [];
  for (const item of raw) {
    if (!isRecord(item)) return fail(`${where}: every option must be an object`);
    if (typeof item.name !== "string" || !NAME.test(item.name)) return fail(`${where}: an option's name must be 1 to ${COMMAND_LIMITS.name} lower-case letters, digits, _ or -`);
    const here = `${where}, option '${item.name}'`;
    if (out.some((o) => o.name === item.name)) return fail(`${here}: two options have this name`);
    const description = describe(item.description, COMMAND_LIMITS.description, `${here}: the description`);
    if (!description.ok) return description;
    const type = OPTION_TYPES.find((t) => t === item.type);
    if (!type) return fail(`${here}: the type must be one of ${OPTION_TYPES.join(", ")}`);
    if (item.required !== undefined && typeof item.required !== "boolean") return fail(`${here}: required must be true or false`);
    const required = item.required === true;
    // Required options come first, so a form and a bot never meet a gap.
    if (required && out.some((o) => !o.required)) return fail(`${here}: required options must come before the optional ones`);
    const choices = parseChoices(item.choices, type, here);
    if (!choices.ok) return choices;
    out.push({ name: item.name, description: description.value, type, required, ...(choices.value ? { choices: choices.value } : {}) });
  }
  return { ok: true, value: out };
}

/**
 * What a bot sends to register its commands: `{ commands: [...] }`, the bot's WHOLE set. Refused as a whole, naming the first thing wrong, so
 * nothing is half registered.
 */
export function parseCommands(input: unknown): Parsed<CommandDef[]> {
  if (!isRecord(input) || !Array.isArray(input.commands)) return fail("the body must be { commands: [...] }");
  if (input.commands.length > COMMAND_LIMITS.commands) return fail(`at most ${COMMAND_LIMITS.commands} commands`);
  const out: CommandDef[] = [];
  for (const item of input.commands) {
    if (!isRecord(item)) return fail("every command must be an object");
    if (typeof item.name !== "string" || !NAME.test(item.name)) return fail(`a command's name must be 1 to ${COMMAND_LIMITS.name} lower-case letters, digits, _ or -`);
    const where = `command '${item.name}'`;
    if (out.some((c) => c.name === item.name)) return fail(`${where}: two commands have this name`);
    const description = describe(item.description, COMMAND_LIMITS.description, `${where}: the description`);
    if (!description.ok) return description;
    const options = parseOptions(item.options, where);
    if (!options.ok) return options;
    out.push({ name: item.name, description: description.value, options: options.value });
  }
  return { ok: true, value: out };
}

/** Options as they were stored: read back leniently (they were validated on the way in), and anything that is not an option is left out. Never throws. */
export function storedOptions(raw: unknown): CommandOption[] {
  const parsed = parseOptions(Array.isArray(raw) ? raw.slice(0, COMMAND_LIMITS.options) : [], "stored");
  return parsed.ok ? parsed.value : [];
}

// --- What a person enters ----------------------------------------------------------------------------------------------------------------

export type OptionValue = string | number | boolean;
export type OptionValues = Record<string, OptionValue>;

export type CheckedOptions = { ok: true; values: OptionValues } | { ok: false; option: string };

/**
 * A person's entries against a command's registered options. Unknown names are refused, required ones must be there, and every value must be of
 * its type: a whole number, a finite number, a true or false, one of the choices, text of one line (cleaned, at most COMMAND_LIMITS.string), a
 * well-formed id for a member or a channel. An empty text for an optional option is the same as leaving it out. Names the first offender.
 */
export function checkOptions(options: CommandOption[], given: unknown): CheckedOptions {
  const entries = given === undefined || given === null ? {} : given;
  if (!isRecord(entries)) return { ok: false, option: "" };
  for (const key of Object.keys(entries)) if (!options.some((o) => o.name === key)) return { ok: false, option: key };
  const values: OptionValues = {};
  for (const option of options) {
    const raw = Object.prototype.hasOwnProperty.call(entries, option.name) ? entries[option.name] : undefined;
    let value: OptionValue | undefined;
    if (raw !== undefined && raw !== null) {
      switch (option.type) {
        case "string": {
          if (typeof raw !== "string" || raw.length > COMMAND_LIMITS.string * 8) return { ok: false, option: option.name };
          const cleaned = cleanLine(raw, COMMAND_LIMITS.string + 1);
          if (cleaned !== null && count(cleaned) > COMMAND_LIMITS.string) return { ok: false, option: option.name };
          value = cleaned ?? undefined;
          break;
        }
        case "integer":
          if (typeof raw !== "number" || !Number.isSafeInteger(raw)) return { ok: false, option: option.name };
          value = raw;
          break;
        case "number":
          if (typeof raw !== "number" || !Number.isFinite(raw)) return { ok: false, option: option.name };
          value = raw;
          break;
        case "boolean":
          if (typeof raw !== "boolean") return { ok: false, option: option.name };
          value = raw;
          break;
        case "member":
        case "channel":
          if (typeof raw !== "string" || !ID.test(raw)) return { ok: false, option: option.name };
          value = raw;
          break;
      }
      if (value !== undefined && option.choices && !option.choices.some((c) => c.value === value)) return { ok: false, option: option.name };
    }
    if (value === undefined) {
      if (option.required) return { ok: false, option: option.name };
      continue;
    }
    values[option.name] = value;
  }
  return { ok: true, values };
}
