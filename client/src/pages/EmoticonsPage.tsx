import { useEffect, useState } from "react";
import * as api from "../api";
import type { Emoticon } from "../api";
import { mediaUrl } from "../api";
import { useAuth } from "../context/AuthContext";
import SaveEmoticonModal from "../components/SaveEmoticonModal";
import ForkEmoticonModal from "../components/ForkEmoticonModal";
import EditEmoticonModal from "../components/EditEmoticonModal";
import { noAutofill } from "../lib/noAutofill";
import Button from "../components/Button";
import FileButton from "../components/FileButton";
import Tabs from "../components/Tabs";

type Tab = "personal" | "saved" | "community";

export default function EmoticonsPage() {
  const { user } = useAuth();
  const [personal, setPersonal] = useState<Emoticon[]>([]);
  const [saved, setSaved] = useState<Emoticon[]>([]);
  const [community, setCommunity] = useState<Emoticon[]>([]);
  const [tab, setTab] = useState<Tab>("personal");
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [savingEmoticon, setSavingEmoticon] = useState<Emoticon | null>(null);
  const [forkingEmoticon, setForkingEmoticon] = useState<Emoticon | null>(null);
  const [editingEmoticon, setEditingEmoticon] = useState<Emoticon | null>(null);
  const [syncNote, setSyncNote] = useState<{ id: string; text: string } | null>(null);

  async function refresh() {
    const r = await api.listEmoticons();
    setPersonal(r.personal);
    setSaved(r.saved);
    setCommunity(r.community);
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setCreating(true);
    setError(null);
    try {
      const uploaded = await api.uploadFile(file);
      await api.createEmoticon({ name, trigger: trigger.startsWith(":") ? trigger : `:${trigger}:`, imageUrl: uploaded.url });
      setName("");
      setTrigger("");
      setFile(null);
      await refresh();
    } catch (err: any) {
      setError(err?.body?.error === "trigger_already_in_use" ? "That trigger is already in use." : "Couldn't create emoticon.");
    } finally {
      setCreating(false);
    }
  }

  async function handleSync(emoticon: Emoticon) {
    try {
      const updated = await api.syncFork(emoticon.id);
      setSyncNote({
        id: emoticon.id,
        text: updated.imageUrl === emoticon.imageUrl ? "Already up to date" : "Updated from the original",
      });
      await refresh();
    } catch {
      setSyncNote({ id: emoticon.id, text: "Couldn't sync - the original may have been deleted" });
      await refresh();
    }
  }

  const list = tab === "personal" ? personal : tab === "saved" ? saved : community;

  return (
    <>
      <div className="main-header">Emoticons</div>
      <div className="panel">
        <form onSubmit={handleCreate} style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 20, flexWrap: "wrap" }}>
          <FileButton file={file} onChange={setFile} accept="image/*" />
          <input {...noAutofill} name="emoticon-name" aria-label="Emoticon name" placeholder="Emoticon name" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 140 }} required />
          <input {...noAutofill} name="emoticon-trigger" aria-label="Emoticon trigger" placeholder=":trigger:" value={trigger} onChange={(e) => setTrigger(e.target.value.toLowerCase())} style={{ width: 140 }} required />
          <Button type="submit" disabled={creating || !file}>
            Create
          </Button>
          {error && <span className="error-text">{error}</span>}
        </form>

        <Tabs
          label="Emoticons"
          value={tab}
          onChange={setTab}
          minHeight="14rem"
          tabs={[
            { id: "personal", label: `My emoticons (${personal.length})` },
            { id: "saved", label: `Saved (${saved.length})` },
            { id: "community", label: `Community (${community.length})` },
          ]}
        >
          {list.length === 0 ? (
            <div className="empty-state">Nothing here yet.</div>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
              {list.map((e) => (
                <div key={e.id} style={{ width: 110, textAlign: "center" }}>
                  <div className="emoji-tile" style={{ width: 72, height: 72, margin: "0 auto" }}>
                    <img src={mediaUrl(e.imageUrl)} alt={e.name} />
                  </div>
                  <div style={{ fontSize: 12, marginTop: 4 }}>{e.trigger}</div>
                  <div className="hint" style={{ fontSize: 11 }}>
                    by {e.creator.username === user?.username ? "you" : e.creator.displayName}
                  </div>
                  {tab === "personal" && e.parent && (
                    <div className="hint" style={{ fontSize: 11 }}>
                      forked from {e.parent.name} by {e.parent.creator.displayName}
                    </div>
                  )}
                  {syncNote?.id === e.id && (
                    <div className="hint" style={{ fontSize: 11 }}>
                      {syncNote.text}
                    </div>
                  )}
                  <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 6, marginTop: 4 }}>
                    {tab !== "personal" && e.creator.id !== user?.id && e.allowSave && tab !== "saved" && (
                      <Button
                        onClick={() => setSavingEmoticon(e)}
                        variant="secondary"
                        size="sm"
                      >
                        Save
                      </Button>
                    )}
                    {tab !== "personal" && e.creator.id !== user?.id && e.allowFork && (
                      <Button
                        onClick={() => setForkingEmoticon(e)}
                        variant="secondary"
                        size="sm"
                      >
                        Fork
                      </Button>
                    )}
                    {tab === "personal" && e.parent && (
                      <Button
                        onClick={() => handleSync(e)}
                        variant="secondary"
                        size="sm"
                      >
                        Sync fork
                      </Button>
                    )}
                    {tab === "saved" && (
                      <Button
                        onClick={() => api.unsaveEmoticon(e.id).then(refresh)}
                        variant="secondary"
                        size="sm"
                      >
                        Unsave
                      </Button>
                    )}
                    {e.creator.id === user?.id && (
                      <Button
                        onClick={() => setEditingEmoticon(e)}
                        variant="secondary"
                        size="sm"
                      >
                        Edit
                      </Button>
                    )}
                    {e.creator.id === user?.id && (
                      <Button
                        onClick={() => api.deleteEmoticon(e.id).then(refresh)}
                        variant="danger"
                        size="sm"
                      >
                        Delete
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Tabs>
      </div>
      {savingEmoticon && (
        <SaveEmoticonModal
          emoticon={savingEmoticon}
          onSaved={refresh}
          onClose={() => setSavingEmoticon(null)}
        />
      )}
      {editingEmoticon && (
        <EditEmoticonModal
          emoticon={editingEmoticon}
          onSaved={() => void refresh()}
          onClose={() => setEditingEmoticon(null)}
        />
      )}
      {forkingEmoticon && (
        <ForkEmoticonModal
          emoticon={forkingEmoticon}
          onForked={() => {
            setTab("personal");
            void refresh();
          }}
          onClose={() => setForkingEmoticon(null)}
        />
      )}
    </>
  );
}
