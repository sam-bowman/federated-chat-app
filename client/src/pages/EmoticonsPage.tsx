import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import type { Emoticon } from "../api";
import { mediaUrl } from "../api";
import { useAuth } from "../context/AuthContext";

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
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      if (fileInputRef.current) fileInputRef.current.value = "";
      await refresh();
    } catch (err: any) {
      setError(err?.body?.error === "trigger_already_in_use" ? "That trigger is already in use." : "Couldn't create emoticon.");
    } finally {
      setCreating(false);
    }
  }

  const list = tab === "personal" ? personal : tab === "saved" ? saved : community;

  return (
    <>
      <div className="main-header">Emoticons</div>
      <div className="panel">
        <form onSubmit={handleCreate} style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 20, flexWrap: "wrap" }}>
          <input type="file" accept="image/*" ref={fileInputRef} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 140 }} required />
          <input placeholder=":trigger:" value={trigger} onChange={(e) => setTrigger(e.target.value.toLowerCase())} style={{ width: 140 }} required />
          <button className="btn" type="submit" disabled={creating || !file}>
            Create
          </button>
          {error && <span className="error-text">{error}</span>}
        </form>

        <div className="tabs" style={{ padding: 0, marginBottom: 10 }}>
          <div className={`tab ${tab === "personal" ? "active" : ""}`} onClick={() => setTab("personal")}>
            My emoticons ({personal.length})
          </div>
          <div className={`tab ${tab === "saved" ? "active" : ""}`} onClick={() => setTab("saved")}>
            Saved ({saved.length})
          </div>
          <div className={`tab ${tab === "community" ? "active" : ""}`} onClick={() => setTab("community")}>
            Community ({community.length})
          </div>
        </div>

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
                <div style={{ display: "flex", justifyContent: "center", gap: 6, marginTop: 4 }}>
                  {tab !== "personal" && e.creator.id !== user?.id && e.allowSave && tab !== "saved" && (
                    <button
                      className="btn-secondary"
                      style={{ fontSize: 11, padding: "2px 6px", borderRadius: 4 }}
                      onClick={() => api.saveEmoticon(e.id).then(refresh)}
                    >
                      Save
                    </button>
                  )}
                  {tab === "saved" && (
                    <button
                      className="btn-secondary"
                      style={{ fontSize: 11, padding: "2px 6px", borderRadius: 4 }}
                      onClick={() => api.unsaveEmoticon(e.id).then(refresh)}
                    >
                      Unsave
                    </button>
                  )}
                  {e.creator.id === user?.id && (
                    <button
                      className="btn-danger"
                      style={{ fontSize: 11, padding: "2px 6px", borderRadius: 4 }}
                      onClick={() => api.deleteEmoticon(e.id).then(refresh)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
