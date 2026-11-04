import { useId, useState } from "react";
import * as api from "../api";
import type { Community } from "../api";
import { botFailureMessage, isValidBotUsername } from "../lib/bots";
import { noAutofill } from "../lib/noAutofill";
import Button from "./Button";

/**
 * Adds a bot of this server to a community (#132), in the community settings' General tab, for someone who may manage the community. The bot
 * joins like a member holding @everyone; what more it may do is the ordinary roles below, and it is removed like any member. The bot's owner
 * tells its manager the name (Settings -> Developer shows it).
 */
export default function AddBotForm({ community, onAdded }: { community: Pick<Community, "id" | "name">; onAdded: () => void | Promise<void> }) {
  const inputId = useId();
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAdded(null);
    try {
      const bot = await api.addBotToCommunity(community.id, username.trim());
      setAdded(bot.displayName);
      setUsername("");
      await onAdded();
    } catch (err) {
      setError(botFailureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="add-bot-form" onSubmit={submit} aria-label="Add a bot to this community">
      <label htmlFor={inputId}>Add a bot</label>
      <div className="add-bot-row">
        <input id={inputId} value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} placeholder="Bot name" maxLength={32} {...noAutofill} />
        <Button type="submit" size="sm" busy={busy} disabled={!isValidBotUsername(username.trim())}>
          Add bot
        </Button>
      </div>
      <div className="hint">A bot can read the channels it is allowed to see here. Only add one you trust.</div>
      {added && <div className="hint" role="status">{added} was added.</div>}
      {error && <div className="error-text">{error}</div>}
    </form>
  );
}
