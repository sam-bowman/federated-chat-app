import { ApiError } from "../api/client";
import type { CommandOption, CommunityCommand } from "../api";

// Slash commands (#132, phase 3b) as the client handles them: finding the one being typed, turning what a form holds into the typed options the
// server expects (the same rules the server checks again), and words for what the server refuses. The server decides everything; this only
// saves a round trip and says what is wrong beside the field.

/**
 * What has been typed of a command's name, or null if no command is being typed: the box starts with `/`, and the caret is still within the first word
 * (no space yet). `/shrug it` is text, a path is text, and so is `/` in the middle of a message: only a command at the very start is a command.
 */
export function commandQuery(value: string, caret: number): string | null {
  if (!value.startsWith("/")) return null;
  if (/\s/.test(value)) return null;
  if (caret < 1) return null;
  return value.slice(1);
}

/** The commands whose name starts with what was typed, then those that contain it, in the order the server gave them (by bot, then as each bot ordered them). */
export function matchCommands(commands: CommunityCommand[], query: string): CommunityCommand[] {
  const q = query.toLowerCase();
  const starts = commands.filter((c) => c.name.startsWith(q));
  const contains = commands.filter((c) => !c.name.startsWith(q) && c.name.includes(q));
  return [...starts, ...contains];
}

/** What a form holds for each option, as the strings and booleans its fields give. */
export type FormValues = Record<string, string | boolean>;

export function initialValues(options: CommandOption[]): FormValues {
  const values: FormValues = {};
  for (const option of options) values[option.name] = option.type === "boolean" ? false : "";
  return values;
}

export type BuiltOptions = { ok: true; options: Record<string, string | number | boolean> } | { ok: false; errors: Record<string, string> };

const WHOLE = /^-?\d{1,15}$/;

/**
 * The typed options for a form's values: text trimmed, a number or a whole number parsed, a choice turned back into its real value, an optional one that
 * was left empty left out. Every problem is reported at once, by option name.
 */
export function buildOptions(options: CommandOption[], values: FormValues): BuiltOptions {
  const out: Record<string, string | number | boolean> = {};
  const errors: Record<string, string> = {};
  for (const option of options) {
    const raw = values[option.name];
    if (option.type === "boolean") {
      if (raw === true) out[option.name] = true;
      continue;
    }
    const text = typeof raw === "string" ? raw.trim() : "";
    if (text === "") {
      if (option.required) errors[option.name] = "Fill this in.";
      continue;
    }
    if (option.choices) {
      const choice = option.choices.find((c) => String(c.value) === text);
      if (choice) out[option.name] = choice.value;
      else errors[option.name] = "Choose one of the choices.";
      continue;
    }
    if (option.type === "integer") {
      if (WHOLE.test(text)) out[option.name] = Number(text);
      else errors[option.name] = "Enter a whole number.";
    } else if (option.type === "number") {
      const n = Number(text);
      if (Number.isFinite(n)) out[option.name] = n;
      else errors[option.name] = "Enter a number.";
    } else {
      out[option.name] = text;
    }
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, options: out };
}

/** Whether every required option has something in it (so the form's button may be pressed); what is in it is checked by buildOptions. */
export function requiredFilled(options: CommandOption[], values: FormValues): boolean {
  return options.every((o) => !o.required || o.type === "boolean" || (typeof values[o.name] === "string" && (values[o.name] as string).trim() !== ""));
}

/** What to say when running a command did not work, and which option it names, if one. */
export function commandFailure(error: unknown, botName: string): { message: string; option?: string } {
  if (!(error instanceof ApiError)) return { message: "Couldn't reach the server. Try again." };
  const body = (typeof error.body === "object" && error.body ? error.body : {}) as { error?: unknown; option?: unknown };
  const code = typeof body.error === "string" ? body.error : "";
  switch (code) {
    case "invalid_options":
      return typeof body.option === "string" && body.option !== ""
        ? { message: "That doesn't fit what the command asks for.", option: body.option }
        : { message: "That doesn't fit what the command asks for." };
    case "bot_offline":
      return { message: `${botName} is offline right now.` };
    case "bot_busy":
      return { message: `${botName} is busy with other requests. Try again in a moment.` };
    case "forbidden":
      return { message: "You can't run commands here." };
    case "not_found":
      return { message: "That command isn't available any more." };
    case "not_community_home":
      return { message: "Commands can only be run in a community on your own server." };
    case "not_a_text_channel":
      return { message: "Commands can only be run in a text channel." };
    default:
      return error.status === 429 ? { message: "You're running commands too fast. Wait a moment." } : { message: "Something went wrong. Try again." };
  }
}
