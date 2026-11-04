import { useCallback, useEffect, useId, useState } from "react";
import * as api from "../api";
import type { Bot } from "../api";
import { getHomeServer } from "../api/client";
import { fetchServerInfo } from "../api/discovery";
import { botFailureMessage, isValidBotUsername } from "../lib/bots";
import { noAutofill } from "../lib/noAutofill";
import Avatar from "./Avatar";
import BotBadge from "./BotBadge";
import Button from "./Button";
import ConfirmModal from "./ConfirmModal";

/** A token the person has just been given: shown here and nowhere else, and gone when they dismiss it. */
function TokenNotice({ bot, token, onDone }: { bot: string; token: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      // Not allowed here (an insecure page, or the clipboard is blocked): the token is on screen to select.
      setCopied(false);
    }
  }
  return (
    <div className="bot-token-notice" role="status">
      <strong>Token for {bot}</strong>
      <p className="hint">
        Copy it now: this is the only time it is shown, and only a fingerprint of it is kept. Anyone who has it can act as this bot, so keep it
        secret. If you lose it, make a new one (that stops the old one working).
      </p>
      <code className="bot-token" aria-label={`Token for ${bot}`}>
        {token}
      </code>
      <div className="bot-token-actions">
        <Button type="button" size="sm" variant="secondary" onClick={copy}>
          {copied ? "Copied" : "Copy token"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          I have saved it
        </Button>
      </div>
    </div>
  );
}

/**
 * Settings -> Developer (#132): make bots, which are accounts for programs, and manage them. A bot acts with a token (shown once), is added to
 * a community by that community's managers, and is held to what its roles allow. Only offered where the server has bots (its discovery
 * document says so).
 */
export default function DeveloperSection() {
  const nameId = useId();
  const displayId = useId();
  const [offered, setOffered] = useState(false);
  const [bots, setBots] = useState<Bot[] | null>(null);
  const [limit, setLimit] = useState<number | null>(null);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<{ bot: string; token: string } | null>(null);
  const [deleting, setDeleting] = useState<Bot | null>(null);

  useEffect(() => {
    const origin = getHomeServer()?.origin;
    if (!origin) return;
    let current = true;
    fetchServerInfo(origin)
      .then((info) => {
        if (current) setOffered(info.botsEnabled === true);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const answer = await api.listBots();
      setBots(answer.bots);
      setLimit(answer.limit);
    } catch (err) {
      setError(botFailureMessage(err));
    }
  }, []);

  useEffect(() => {
    if (offered) void load();
  }, [offered, load]);

  if (!offered) return null;

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const made = await api.createBot({ username: username.trim(), displayName: displayName.trim() || undefined });
      setUsername("");
      setDisplayName("");
      setToken({ bot: made.bot.displayName, token: made.token });
      await load();
    } catch (err) {
      setError(botFailureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function regenerate(bot: Bot) {
    setError(null);
    try {
      const answer = await api.regenerateBotToken(bot.id);
      setToken({ bot: bot.displayName, token: answer.token });
    } catch (err) {
      setError(botFailureMessage(err));
    }
  }

  async function remove(bot: Bot) {
    setError(null);
    try {
      await api.deleteBot(bot.id);
      if (token?.bot === bot.displayName) setToken(null);
      await load();
    } catch (err) {
      setDeleting(null);
      setError(botFailureMessage(err));
    }
  }

  const atLimit = limit !== null && bots !== null && bots.length >= limit;

  return (
    <>
      <h3>Developer</h3>
      <p className="hint">
        A bot is an account for a program. It has no password: it acts with a token. It can only do something in a community whose manager has
        added it, and only what that community&apos;s roles allow. Everyone sees it marked as a bot.
      </p>
      {token && <TokenNotice bot={token.bot} token={token.token} onDone={() => setToken(null)} />}
      {bots && bots.length > 0 && (
        <ul className="bot-list" aria-label="Your bots">
          {bots.map((bot) => (
            <li key={bot.id} className="bot-row">
              <Avatar user={bot} size="sm" />
              <div className="grow">
                <div>
                  {bot.displayName} <BotBadge user={bot} />
                </div>
                <div className="hint">{bot.identity}</div>
              </div>
              <Button type="button" size="sm" variant="secondary" aria-label={`New token for ${bot.displayName}`} onClick={() => regenerate(bot)}>
                New token
              </Button>
              <Button type="button" size="sm" variant="danger" aria-label={`Delete ${bot.displayName}`} onClick={() => setDeleting(bot)}>
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}
      {bots && bots.length === 0 && <p className="hint">You have no bots yet.</p>}
      <form className="bot-form" onSubmit={create}>
        <label htmlFor={nameId}>Bot name</label>
        <input
          id={nameId}
          value={username}
          onChange={(e) => setUsername(e.target.value.toLowerCase())}
          placeholder="my_bot"
          maxLength={32}
          {...noAutofill}
        />
        <label htmlFor={displayId}>Display name (optional)</label>
        <input id={displayId} value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={64} placeholder="My Bot" {...noAutofill} />
        <div className="hint">
          The name is how a community&apos;s managers find it to add it, and is taken from the same pool as everyone&apos;s: 3 to 32 lowercase
          letters, digits or underscores.
          {limit !== null && ` You may have ${limit}.`}
        </div>
        {error && <div className="error-text">{error}</div>}
        <Button type="submit" busy={busy} disabled={!isValidBotUsername(username.trim()) || atLimit}>
          Make a bot
        </Button>
      </form>
      {deleting && (
        <ConfirmModal
          title={`Delete ${deleting.displayName}?`}
          message="Its token stops working at once, it leaves every community it is in, and its messages are deleted. The name stays taken. This cannot be undone."
          confirmLabel="Delete bot"
          danger
          onConfirm={() => void remove(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}
