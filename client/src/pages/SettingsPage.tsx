import { useState } from "react";
import * as api from "../api";
import { useAuth } from "../context/AuthContext";
import Avatar from "../components/Avatar";

const STATUSES = ["ONLINE", "AWAY", "BUSY", "DO_NOT_DISTURB", "INVISIBLE"] as const;

export default function SettingsPage() {
  const { user, refreshUser } = useAuth();
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [bio, setBio] = useState(user?.bio ?? "");
  const [customStatus, setCustomStatus] = useState(user?.presence.customStatus ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  if (!user) return null;

  async function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const uploaded = await api.uploadFile(file);
    await api.updateMe({ avatarUrl: uploaded.url });
    await refreshUser();
  }

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.updateMe({ displayName, bio: bio || null });
      await refreshUser();
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } finally {
      setSaving(false);
    }
  }

  async function handleStatusChange(status: string) {
    await api.setPresence({ status });
    await refreshUser();
  }

  async function handleCustomStatusSave() {
    await api.setPresence({ customStatus: customStatus || null });
    await refreshUser();
  }

  return (
    <>
      <div className="main-header">Settings</div>
      <div className="panel" style={{ maxWidth: 480 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 20 }}>
          <Avatar user={user} />
          <label className="btn-secondary" style={{ borderRadius: 6, padding: "6px 12px" }}>
            Change avatar
            <input type="file" accept="image/*" style={{ display: "none" }} onChange={handleAvatarChange} />
          </label>
        </div>

        <h3>Identity</h3>
        <p className="hint">{user.identity} (cannot be changed)</p>

        <form onSubmit={handleSaveProfile} style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 24 }}>
          <label className="hint">Display name</label>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          <label className="hint">Bio</label>
          <textarea value={bio} onChange={(e) => setBio(e.target.value)} rows={3} />
          <button className="btn" type="submit" disabled={saving} style={{ alignSelf: "flex-start" }}>
            {saved ? "Saved!" : "Save profile"}
          </button>
        </form>

        <h3>Presence</h3>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          {STATUSES.map((s) => (
            <button
              key={s}
              className={user.presence.status === s ? "btn" : "btn-secondary"}
              style={{ borderRadius: 6, fontSize: 12 }}
              onClick={() => handleStatusChange(s)}
            >
              {s.replace(/_/g, " ")}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            placeholder="Custom status message…"
            value={customStatus}
            onChange={(e) => setCustomStatus(e.target.value)}
            style={{ flex: 1 }}
          />
          <button className="btn-secondary" style={{ borderRadius: 6 }} onClick={handleCustomStatusSave}>
            Set
          </button>
        </div>
      </div>
    </>
  );
}
