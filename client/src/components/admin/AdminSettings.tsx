import { useCallback, useEffect, useId, useRef, useState } from "react";
import * as api from "../../api";
import type { AdminSetting, AdminSettings as AdminSettingsData } from "../../api";
import { settingErrorMessage } from "../../lib/adminText";
import { SETTING_GROUPS, SETTING_TEXT, domainsToLines, draftToValue, isDirty, sourceWords, valueLabel } from "../../lib/adminSettings";
import { noAutofill } from "../../lib/noAutofill";
import Button from "../Button";
import { SudoCancelled, useSudo } from "./SudoContext";

/**
 * The settings an admin can change without a shell (#206, phase 4). Each shows the value in effect, where it comes from, and a control. A setting the
 * server's environment sets is locked: shown, not changeable, because whoever wrote it in the deployment meant it. Everything else is changed through
 * sudo mode, takes effect at once, and is written to the audit log by the server, which holds each value to the same strict check the environment gets.
 */
export default function AdminSettings() {
  const sudo = useSudo();
  const [data, setData] = useState<AdminSettingsData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  // Only the latest question may answer.
  const asked = useRef(0);

  useEffect(() => {
    const mine = ++asked.current;
    api
      .getAdminSettings()
      .then((result) => {
        if (mine !== asked.current) return;
        setData(result);
        setLoadError(null);
        // A box starts from what is in effect, and keeps what the person has typed in a box they have not saved.
        setDrafts((current) => Object.fromEntries(result.settings.map((s) => [s.key, current[s.key] !== undefined && isDirty(s, current[s.key]) ? current[s.key] : startOf(s)])));
      })
      .catch(() => mine === asked.current && setLoadError("Couldn't load the settings. Try again."));
  }, [reload]);

  /** Does one change in sudo mode and shows the setting as the server now has it. A confirmation they back out of is not an error. */
  const change = useCallback(
    async (setting: AdminSetting, run: (token: string) => Promise<{ setting: AdminSetting }>) => {
      setBusyKey(setting.key);
      setErrors((current) => ({ ...current, [setting.key]: "" }));
      setSaved(null);
      try {
        const result = await sudo.run(run);
        setData((current) => (current ? { ...current, settings: current.settings.map((s) => (s.key === setting.key ? result.setting : s)) } : current));
        setDrafts((current) => ({ ...current, [setting.key]: startOf(result.setting) }));
        setSaved(setting.key);
        // A change can move another setting (the community default follows its limit), so look at the lot again.
        setReload((n) => n + 1);
      } catch (err) {
        if (!(err instanceof SudoCancelled)) setErrors((current) => ({ ...current, [setting.key]: settingErrorMessage(err) }));
      } finally {
        setBusyKey(null);
      }
    },
    [sudo]
  );

  if (loadError) return <p className="error-text">{loadError}</p>;
  if (!data) return <p className="hint">Loading…</p>;

  return (
    <div className="admin-settings">
      <p className="hint">
        Changes here take effect at once, without a restart (other copies of the server follow within about 15 seconds), and are written to the audit log. A setting the server&apos;s
        environment sets is shown but locked: change it where the server is deployed. Secrets, the server&apos;s domain, storage and rate limits are never changed from a browser.
      </p>
      {data.warnings.length > 0 && (
        <div role="alert" className="error-text">
          {data.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      )}
      {SETTING_GROUPS.map((group) => {
        const rows = data.settings.filter((s) => s.group === group.id);
        if (rows.length === 0) return null;
        return (
          <section key={group.id} className="admin-settings-group" aria-label={group.title}>
            <h3>{group.title}</h3>
            <ul className="admin-settings-rows">
              {rows.map((setting) => (
                <SettingRow
                  key={setting.key}
                  setting={setting}
                  draft={drafts[setting.key] ?? startOf(setting)}
                  onDraft={(value) => setDrafts((current) => ({ ...current, [setting.key]: value }))}
                  busy={busyKey === setting.key}
                  disabled={busyKey !== null}
                  error={errors[setting.key] || null}
                  justSaved={saved === setting.key}
                  onSave={() => void change(setting, (token) => api.adminSetSetting(setting.key, draftToValue(setting, drafts[setting.key] ?? startOf(setting)), token))}
                  onReset={() => void change(setting, (token) => api.adminResetSetting(setting.key, token))}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

const startOf = (setting: AdminSetting) => (setting.kind === "domains" ? domainsToLines(setting.value) : setting.value);

interface RowProps {
  setting: AdminSetting;
  draft: string;
  onDraft: (value: string) => void;
  busy: boolean;
  disabled: boolean;
  error: string | null;
  justSaved: boolean;
  onSave: () => void;
  onReset: () => void;
}

function SettingRow({ setting, draft, onDraft, busy, disabled, error, justSaved, onSave, onReset }: RowProps) {
  const id = useId();
  const text = SETTING_TEXT[setting.key];
  const label = text?.label ?? setting.key;
  const dirty = isDirty(setting, draft);
  const choices = setting.kind === "boolean" ? ["true", "false"] : (setting.choices ?? []);

  return (
    <li className="admin-setting-row" data-source={setting.source}>
      <label htmlFor={id} className="admin-setting-label">
        {label}
      </label>
      {text && <div className="hint">{text.help}</div>}
      {setting.kind === "domains" ? (
        <textarea id={id} {...noAutofill} rows={3} value={draft} disabled={setting.locked || disabled} onChange={(e) => onDraft(e.target.value)} placeholder="chat.example.com" />
      ) : setting.kind === "text" ? (
        <input id={id} {...noAutofill} type="text" maxLength={60} value={draft} disabled={setting.locked || disabled} onChange={(e) => onDraft(e.target.value)} />
      ) : (
        <select id={id} value={draft} disabled={setting.locked || disabled} onChange={(e) => onDraft(e.target.value)}>
          {choices.map((value) => (
            <option key={value} value={value}>
              {valueLabel(setting, value)}
            </option>
          ))}
        </select>
      )}
      <div className="admin-setting-source">
        <span className="admin-setting-badge">{sourceWords(setting)}</span>
        {setting.locked ? (
          <span className="hint">
            <code>{setting.key}</code> is set where the server is deployed, so it can only be changed there (and the server restarted).
          </span>
        ) : (
          setting.source !== "database" && <span className="hint">Default: {valueLabel(setting, setting.default)}</span>
        )}
      </div>
      {setting.problem && (
        <p className="error-text" role="note">
          The value stored here is not valid, so it is not in use: {setting.problem}
        </p>
      )}
      {!setting.locked && (
        <div className="admin-user-actions">
          <Button type="button" size="sm" busy={busy} disabled={disabled || !dirty} onClick={onSave}>
            Save
          </Button>
          {setting.source === "database" && (
            <Button type="button" variant="secondary" size="sm" disabled={disabled} onClick={onReset}>
              Back to the default ({valueLabel(setting, setting.default)})
            </Button>
          )}
          {justSaved && !error && <span role="status">Saved.</span>}
        </div>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
