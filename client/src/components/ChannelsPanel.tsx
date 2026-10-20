import { useState } from "react";
import * as api from "../api";
import { ApiError } from "../api/client";
import type { Channel, Community } from "../api";
import ConfirmModal from "./ConfirmModal";
import { noAutofill } from "../lib/noAutofill";
import Button from "./Button";

interface Draft {
  id: string;
  name: string;
  topic: string;
}

function errorMessage(err: unknown): string {
  const code = err instanceof ApiError ? (err.body as { error?: string } | null)?.error : undefined;
  if (code === "last_channel") return "A community has to keep at least one channel.";
  if (code === "forbidden") return "You don't have permission to manage channels.";
  if (code === "channel_not_found") return "That channel no longer exists.";
  return "Something went wrong. Try again.";
}

export default function ChannelsPanel({ community, onChanged }: { community: Community; onChanged: () => Promise<void> }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<Channel | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const channels = [...community.channels].sort((a, b) => a.position - b.position);

  async function run(action: () => Promise<unknown>, onDone?: () => void) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await onChanged();
      onDone?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function move(index: number, by: -1 | 1) {
    const order = channels.map((c) => c.id);
    [order[index], order[index + by]] = [order[index + by], order[index]];
    void run(() => api.reorderChannels(community.id, order));
  }

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    void run(
      () => api.updateChannel(community.id, draft.id, { name: draft.name.trim(), topic: draft.topic.trim() || null }),
      () => setDraft(null)
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.375rem" }}>
      {error && <div className="error-text">{error}</div>}
      <div style={{ maxHeight: "22.5rem", overflowY: "auto", display: "flex", flexDirection: "column", gap: "0.375rem" }}>
        {channels.map((channel, index) =>
          draft?.id === channel.id ? (
            <form key={channel.id} onSubmit={handleSave} className="friend-request-row" style={{ flexDirection: "column", alignItems: "stretch", marginBottom: 0 }}>
              <label className="hint">Name</label>
              <input {...noAutofill} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={50} autoFocus required />
              <label className="hint">Topic (optional)</label>
              <input {...noAutofill} value={draft.topic} onChange={(e) => setDraft({ ...draft, topic: e.target.value })} maxLength={256} />
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <Button type="submit" disabled={busy || !draft.name.trim()}>
                  Save channel
                </Button>
                <Button type="button" onClick={() => setDraft(null)} variant="secondary">
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <div key={channel.id} className="friend-request-row" style={{ marginBottom: 0 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.125rem" }}>
                <Button
                  aria-label={`Move ${channel.name} up`}
                  disabled={busy || index === 0}
                  onClick={() => move(index, -1)}
                  variant="secondary"
                  size="sm"
                >
                  ▲
                </Button>
                <Button
                  aria-label={`Move ${channel.name} down`}
                  disabled={busy || index === channels.length - 1}
                  onClick={() => move(index, 1)}
                  variant="secondary"
                  size="sm"
                >
                  ▼
                </Button>
              </div>
              <div className="grow">
                <div>{channel.type === "VOICE" ? "🔊" : "#"} {channel.name}</div>
                {channel.topic && <div className="hint">{channel.topic}</div>}
              </div>
              <Button
                onClick={() => {
                  setError(null);
                  setDraft({ id: channel.id, name: channel.name, topic: channel.topic ?? "" });
                }}
                variant="secondary"
                size="sm"
              >
                Edit
              </Button>
              {channels.length > 1 && (
                <Button onClick={() => setDeleting(channel)} variant="danger" size="sm">
                  Delete
                </Button>
              )}
            </div>
          )
        )}
      </div>
      {channels.length === 1 && <p className="hint">A community always keeps at least one channel, so this one can't be deleted.</p>}

      {deleting && (
        <ConfirmModal
          title="Delete channel"
          message={`Permanently delete #${deleting.name}? Every message in it is deleted with it, for everyone, and this can't be undone.`}
          confirmLabel="Delete channel"
          danger
          onConfirm={() => void run(() => api.deleteChannel(community.id, deleting.id))}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
