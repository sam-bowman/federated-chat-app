import { useCallback, useEffect, useId, useState } from "react";
import * as api from "../api";
import type { Community, Webhook } from "../api";
import { getHomeServer } from "../api/client";
import { fetchServerInfo } from "../api/discovery";
import { isValidWebhookName, webhookFailureMessage, WEBHOOK_NAME_MAX } from "../lib/webhooks";
import { noAutofill } from "../lib/noAutofill";
import Avatar from "./Avatar";
import BotBadge from "./BotBadge";
import Button from "./Button";
import ConfirmModal from "./ConfirmModal";
import FileButton from "./FileButton";

type TextChannel = { id: string; name: string };

/** The address a webhook has just been given: shown here and nowhere else, and gone when they dismiss it. */
function UrlNotice({ name, url, onDone }: { name: string; url: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Not allowed here (an insecure page, or the clipboard is blocked): the address is on screen to select.
      setCopied(false);
    }
  }
  return (
    <div className="webhook-url-notice" role="status">
      <strong>Address for {name}</strong>
      <p className="hint">
        Copy it now: this is the only time it is shown, and only a fingerprint of its secret is kept. Anyone who has it can post in the channel as
        this webhook, even where they could not send messages themselves, so keep it private. If you lose it, make a new address (that stops the
        old one working).
      </p>
      <code className="webhook-url" aria-label={`Address for ${name}`}>
        {url}
      </code>
      <div className="webhook-actions">
        <Button type="button" size="sm" variant="secondary" onClick={copy}>
          {copied ? "Copied" : "Copy address"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          I have saved it
        </Button>
      </div>
    </div>
  );
}

/** What choosing a picture for a webhook needs: the file chosen, uploaded when the form is saved. Only a picture is a picture. */
function usePicture() {
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  function choose(next: File | null) {
    if (next && !next.type.startsWith("image/")) {
      setProblem("That isn't a picture. Choose a PNG, JPEG, GIF or WebP image.");
      setFile(null);
      return;
    }
    setProblem(null);
    setFile(next);
  }
  return { file, problem, choose, clear: () => setFile(null) };
}

interface FormProps {
  channels: TextChannel[];
  initial: { name: string; channelId: string };
  submitLabel: string;
  pictureLabel: string;
  /** Called with what to send; the picture has already been uploaded, and is the address of it (undefined when none was chosen). */
  onSubmit: (values: { name: string; channelId: string; avatarUrl?: string }) => Promise<void>;
  onCancel?: () => void;
  disabled?: boolean;
  /** Empty the fields after a successful save (making a webhook), instead of leaving them as they are (the form is about to go away). */
  resetAfter?: boolean;
}

/** The fields of a webhook, for making one and for changing one. */
function WebhookForm({ channels, initial, submitLabel, pictureLabel, onSubmit, onCancel, disabled, resetAfter }: FormProps) {
  const nameId = useId();
  const channelId = useId();
  const [name, setName] = useState(initial.name);
  const [channel, setChannel] = useState(initial.channelId);
  const picture = usePicture();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    let avatarUrl: string | undefined;
    if (picture.file) {
      try {
        avatarUrl = (await api.uploadFile(picture.file)).url;
      } catch {
        setError("Couldn't use that picture. It may be too large; try a smaller one.");
        setBusy(false);
        return;
      }
    }
    try {
      await onSubmit({ name: name.trim(), channelId: channel, avatarUrl });
      picture.clear();
      if (resetAfter) setName("");
    } catch (err) {
      setError(webhookFailureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="webhook-form" onSubmit={submit}>
      <label htmlFor={nameId}>Webhook name</label>
      <input id={nameId} value={name} onChange={(e) => setName(e.target.value)} maxLength={WEBHOOK_NAME_MAX} placeholder="Deploys" {...noAutofill} />
      <label htmlFor={channelId}>Channel</label>
      <select id={channelId} value={channel} onChange={(e) => setChannel(e.target.value)}>
        {channels.map((c) => (
          <option key={c.id} value={c.id}>
            #{c.name}
          </option>
        ))}
      </select>
      <div className="webhook-picture">
        <FileButton file={picture.file} onChange={picture.choose} accept="image/*" label={pictureLabel} />
      </div>
      {picture.problem && <div className="error-text">{picture.problem}</div>}
      {error && <div className="error-text">{error}</div>}
      <div className="webhook-actions">
        <Button type="submit" size="sm" busy={busy} disabled={disabled || !isValidWebhookName(name) || !channel}>
          {submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : null);

/**
 * Community settings -> Integrations (#132, phase 2): the community's incoming webhooks. A webhook is a secret address a program posts to, to
 * put a message in one channel; making, changing, re-keying and deleting them needs Manage webhooks (the server decides too). The address is
 * shown once, when it is made or replaced.
 */
export default function WebhooksPanel({ community }: { community: Community }) {
  const channels: TextChannel[] = community.channels.filter((c) => c.type === "TEXT").map((c) => ({ id: c.id, name: c.name }));
  const channelName = (id: string) => channels.find((c) => c.id === id)?.name ?? "a channel that is gone";

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [webhooks, setWebhooks] = useState<Webhook[] | null>(null);
  const [limit, setLimit] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ name: string; url: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [rekeying, setRekeying] = useState<Webhook | null>(null);
  const [deleting, setDeleting] = useState<Webhook | null>(null);

  // Whether this server has switched webhooks off. Unknown (still asking, or it did not answer) is treated as on: the server decides anyway.
  useEffect(() => {
    const origin = getHomeServer()?.origin;
    if (!origin) return;
    let current = true;
    fetchServerInfo(origin)
      .then((info) => {
        if (current) setEnabled(info.webhooksEnabled === true);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const answer = await api.listWebhooks(community.id);
      setWebhooks(answer.webhooks);
      setLimit(answer.limit);
    } catch (err) {
      setError(webhookFailureMessage(err));
    }
  }, [community.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function make(values: { name: string; channelId: string; avatarUrl?: string }) {
    const made = await api.createWebhook(community.id, values);
    setNotice({ name: made.webhook.name, url: made.url });
    setError(null);
    await load();
  }

  async function change(webhook: Webhook, values: { name: string; channelId: string; avatarUrl?: string }) {
    await api.updateWebhook(community.id, webhook.id, values);
    setEditing(null);
    setError(null);
    await load();
  }

  async function rekey(webhook: Webhook) {
    setError(null);
    try {
      const answer = await api.rotateWebhookUrl(community.id, webhook.id);
      setNotice({ name: webhook.name, url: answer.url });
    } catch (err) {
      setError(webhookFailureMessage(err));
    }
  }

  async function remove(webhook: Webhook) {
    setError(null);
    try {
      await api.deleteWebhook(community.id, webhook.id);
      if (notice?.name === webhook.name) setNotice(null);
      await load();
    } catch (err) {
      setError(webhookFailureMessage(err));
    }
  }

  const off = enabled === false;
  const atLimit = limit !== null && webhooks !== null && webhooks.length >= limit;

  return (
    <>
      <p className="hint">
        A webhook is a secret address a program can post to, to put a message in one channel (a build server, Sonarr, a script). Its messages are
        marked as coming from a bot, under the name you give it, and it posts even where nobody could send messages themselves, which is why
        only people with the Manage webhooks permission can make one.
      </p>
      {off && (
        <p className="hint" role="status">
          This server has switched webhooks off: none can be made, and posts to the ones below are refused. You can still delete them.
        </p>
      )}
      {notice && <UrlNotice name={notice.name} url={notice.url} onDone={() => setNotice(null)} />}
      {error && <div className="error-text">{error}</div>}
      {webhooks && webhooks.length > 0 && (
        <ul className="webhook-list" aria-label="Webhooks">
          {webhooks.map((webhook) => (
            <li key={webhook.id} className="webhook-row">
              <Avatar user={{ displayName: webhook.name, avatarUrl: webhook.avatarUrl }} size="sm" />
              <div className="grow">
                <div>
                  {webhook.name} <BotBadge user={{ isBot: true }} />
                </div>
                <div className="hint">
                  Posts in #{channelName(webhook.channelId)}
                  {webhook.createdBy ? ` · made by ${webhook.createdBy.displayName}` : ""}
                  {" · "}
                  {when(webhook.lastUsedAt) ? `last used ${when(webhook.lastUsedAt)}` : "never used"}
                </div>
              </div>
              <div className="webhook-actions">
                <Button type="button" size="sm" variant="secondary" aria-label={`Edit ${webhook.name}`} onClick={() => setEditing(editing === webhook.id ? null : webhook.id)}>
                  Edit
                </Button>
                {!off && (
                  <Button type="button" size="sm" variant="secondary" aria-label={`New address for ${webhook.name}`} onClick={() => setRekeying(webhook)}>
                    New address
                  </Button>
                )}
                <Button type="button" size="sm" variant="danger" aria-label={`Delete ${webhook.name}`} onClick={() => setDeleting(webhook)}>
                  Delete
                </Button>
              </div>
              {editing === webhook.id && (
                <div className="webhook-edit">
                  <WebhookForm
                    channels={channels}
                    initial={{ name: webhook.name, channelId: webhook.channelId }}
                    submitLabel="Save changes"
                    pictureLabel={webhook.avatarUrl ? "Change picture" : "Choose a picture"}
                    onSubmit={(values) => change(webhook, values)}
                    onCancel={() => setEditing(null)}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {webhooks && webhooks.length === 0 && <p className="hint">This community has no webhooks yet.</p>}
      {!off && (
        <>
          <h4>Make a webhook</h4>
          {channels.length === 0 ? (
            <p className="hint">This community has no text channel to post in.</p>
          ) : (
            <WebhookForm
              channels={channels}
              initial={{ name: "", channelId: channels[0].id }}
              submitLabel="Make a webhook"
              pictureLabel="Choose a picture"
              onSubmit={make}
              disabled={atLimit}
              resetAfter
            />
          )}
          {limit !== null && <div className="hint">{atLimit ? `This community has the most the server allows (${limit}).` : `A community may have ${limit}.`}</div>}
        </>
      )}
      {rekeying && (
        <ConfirmModal
          title={`New address for ${rekeying.name}?`}
          message="The old address stops working at once, so whatever posts to it stops until you give it the new one."
          confirmLabel="Make a new address"
          onConfirm={() => void rekey(rekeying)}
          onClose={() => setRekeying(null)}
        />
      )}
      {deleting && (
        <ConfirmModal
          title={`Delete ${deleting.name}?`}
          message="Its address stops working at once. The messages it posted stay, under its name. This cannot be undone."
          confirmLabel="Delete webhook"
          danger
          onConfirm={() => void remove(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}
