import { useEffect, useId, useRef, useState } from "react";
import type { CommandOption, CommunityCommand } from "../api";
import { buildOptions, commandFailure, initialValues, requiredFilled, type FormValues } from "../lib/commands";
import { noAutofill } from "../lib/noAutofill";
import BotBadge from "./BotBadge";
import Button from "./Button";

interface Props {
  command: CommunityCommand;
  /** The community's members and text channels, for the options that name one. */
  members: { id: string; displayName: string; identity: string }[];
  channels: { id: string; name: string }[];
  /** Runs it. Rejects with what the server said, which is worded here and shown in the form. */
  onSubmit: (options: Record<string, string | number | boolean>) => Promise<void>;
  onCancel: () => void;
}

/**
 * The small form a slash command asks its options in (#132, phase 3b): one labelled field for each, required ones marked, the bot named (it will see what is
 * entered), Send and Cancel (Escape cancels). Each option's rules are checked here as well as by the server, so a mistake is shown beside its field. A bot
 * that is offline cannot be sent anything, and the form says so instead of letting the person wait.
 */
export default function CommandForm({ command, members, channels, onSubmit, onCancel }: Props) {
  const base = useId();
  const [values, setValues] = useState<FormValues>(() => initialValues(command.options));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const botName = command.bot.displayName;

  // The first field is ready to type in.
  useEffect(() => {
    form.current?.querySelector<HTMLElement>("input:not([type=checkbox]), select, input[type=checkbox]")?.focus();
  }, []);

  function set(name: string, value: string | boolean) {
    setValues((v) => ({ ...v, [name]: value }));
    setErrors((e) => (name in e ? Object.fromEntries(Object.entries(e).filter(([k]) => k !== name)) : e));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !command.botOnline) return;
    const built = buildOptions(command.options, values);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      await onSubmit(built.options);
    } catch (err) {
      const said = commandFailure(err, botName);
      setFailure(said.message);
      if (said.option) setErrors({ [said.option]: "Not accepted." });
      setBusy(false);
    }
  }

  function field(option: CommandOption) {
    const id = `${base}-${option.name}`;
    const value = values[option.name];
    const error = errors[option.name];
    const common = { id, "aria-invalid": error ? true : undefined, "aria-describedby": `${id}-hint${error ? ` ${id}-error` : ""}` };
    let control: React.ReactNode;
    if (option.type === "boolean") {
      control = <input {...common} type="checkbox" checked={value === true} onChange={(e) => set(option.name, e.target.checked)} />;
    } else if (option.choices) {
      control = (
        <select {...common} value={typeof value === "string" ? value : ""} onChange={(e) => set(option.name, e.target.value)}>
          <option value="">{option.required ? "Choose…" : "None"}</option>
          {option.choices.map((c) => (
            <option key={String(c.value)} value={String(c.value)}>
              {c.name}
            </option>
          ))}
        </select>
      );
    } else if (option.type === "member") {
      control = (
        <select {...common} value={typeof value === "string" ? value : ""} onChange={(e) => set(option.name, e.target.value)}>
          <option value="">{option.required ? "Choose a member…" : "None"}</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName} ({m.identity})
            </option>
          ))}
        </select>
      );
    } else if (option.type === "channel") {
      control = (
        <select {...common} value={typeof value === "string" ? value : ""} onChange={(e) => set(option.name, e.target.value)}>
          <option value="">{option.required ? "Choose a channel…" : "None"}</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              #{c.name}
            </option>
          ))}
        </select>
      );
    } else if (option.type === "integer" || option.type === "number") {
      control = (
        <input
          {...noAutofill}
          {...common}
          type="number"
          step={option.type === "integer" ? 1 : "any"}
          inputMode={option.type === "integer" ? "numeric" : "decimal"}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => set(option.name, e.target.value)}
        />
      );
    } else {
      control = <input {...noAutofill} {...common} type="text" maxLength={2000} value={typeof value === "string" ? value : ""} onChange={(e) => set(option.name, e.target.value)} />;
    }
    return (
      <div key={option.name} className={option.type === "boolean" ? "command-field command-field-check" : "command-field"}>
        <label htmlFor={id}>
          {option.name}
          {option.required && <span className="command-required"> (required)</span>}
        </label>
        {control}
        <div className="hint" id={`${id}-hint`}>
          {option.description}
        </div>
        {error && (
          <div className="error-text" id={`${id}-error`}>
            {error}
          </div>
        )}
      </div>
    );
  }

  return (
    <form
      ref={form}
      className="command-form"
      role="form"
      aria-label={`Run /${command.name}`}
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="command-form-head">
        <strong>/{command.name}</strong>
        <span className="hint">
          {command.description} · {botName} <BotBadge user={command.bot} />
        </span>
      </div>
      {command.options.map(field)}
      {!command.botOnline && (
        <div className="error-text" role="status">
          {botName} is offline right now, so it can&apos;t answer.
        </div>
      )}
      {failure && (
        <div className="error-text" role="alert">
          {failure}
        </div>
      )}
      <div className="hint">{botName} will see what you enter here.</div>
      <div className="command-form-actions">
        <Button type="submit" size="sm" busy={busy} disabled={!command.botOnline || !requiredFilled(command.options, values)}>
          Send
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
