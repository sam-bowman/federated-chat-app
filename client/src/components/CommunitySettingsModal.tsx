import { useEffect, useState } from "react";
import * as api from "../api";
import type { Community, CommunityBan, CommunityMember } from "../api";
import { managementAccess, viewerPermissions as permissionsOf } from "../lib/permissions";
import { useAppData } from "../context/AppDataContext";
import Avatar from "./Avatar";
import ConfirmModal from "./ConfirmModal";
import Modal from "./Modal";
import RolesPanel from "./RolesPanel";
import ChannelsPanel from "./ChannelsPanel";
import MemberRoles from "./MemberRoles";
import { noAutofill } from "../lib/noAutofill";

type Tab = "general" | "members" | "channels" | "roles" | "banned";

interface Props {
  community: Community;
  /** Who is looking: decides which tabs and controls appear (the server still checks every request). */
  viewer: { id: string; identity: string };
  onClose: () => void;
}

export default function CommunitySettingsModal({ community, viewer, onClose }: Props) {
  const { refreshCommunities } = useAppData();
  const access = managementAccess(community, viewer);
  const viewerPermissions = permissionsOf(community, viewer);
  // Only the tabs this viewer can use, in the usual order, opening on the first of them.
  const tabs: { id: Tab; label: string }[] = [
    ...(access.general ? [{ id: "general" as const, label: "General" }] : []),
    ...(access.members ? [{ id: "members" as const, label: `Members (${community.members.length})` }] : []),
    ...(access.channels ? [{ id: "channels" as const, label: "Channels" }] : []),
    ...(access.roles ? [{ id: "roles" as const, label: "Roles" }] : []),
    ...(access.ban ? [{ id: "banned" as const, label: "Banned" }] : []),
  ];
  const [chosenTab, setChosenTab] = useState<Tab>(tabs[0]?.id ?? "general");
  // If a role change takes the chosen tab away while the modal is open, fall back to one still allowed.
  const tab = tabs.some((t) => t.id === chosenTab) ? chosenTab : (tabs[0]?.id ?? chosenTab);

  const [name, setName] = useState(community.name);
  const [description, setDescription] = useState(community.description ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [bans, setBans] = useState<CommunityBan[]>([]);
  const [kicking, setKicking] = useState<CommunityMember | null>(null);
  const [banning, setBanning] = useState<CommunityMember | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);

  useEffect(() => {
    if (tab === "banned") {
      api.listCommunityBans(community.id).then(setBans).catch(() => setMemberError("Couldn't load banned users."));
    }
  }, [tab, community.id]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.updateCommunity(community.id, { name, description: description || null });
      await refreshCommunities();
      onClose();
    } catch {
      setError("Couldn't save changes.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleKick(member: CommunityMember) {
    setMemberError(null);
    try {
      await api.kickMember(community.id, member.id);
      await refreshCommunities();
    } catch {
      setMemberError(`Couldn't kick ${member.displayName}.`);
    }
  }

  async function handleBan(member: CommunityMember) {
    setMemberError(null);
    try {
      await api.banMember(community.id, member.id);
      await refreshCommunities();
    } catch {
      setMemberError(`Couldn't ban ${member.displayName}.`);
    }
  }

  async function handleUnban(ban: CommunityBan) {
    setMemberError(null);
    try {
      await api.unbanMember(community.id, ban.user.id);
      setBans((prev) => prev.filter((b) => b.user.id !== ban.user.id));
    } catch {
      setMemberError(`Couldn't unban ${ban.user.displayName}.`);
    }
  }

  return (
    <Modal title="Community settings" onClose={onClose} width={580}>
      <div className="tabs" style={{ padding: 0, marginBottom: 14 }}>
        {tabs.map((t) => (
          <div key={t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => setChosenTab(t.id)}>
            {t.label}
          </div>
        ))}
      </div>

      {tab === "general" && access.general && (
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <label className="hint">Name</label>
          <input {...noAutofill} value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
          <label className="hint">Description</label>
          <textarea {...noAutofill} value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
          {error && <div className="error-text">{error}</div>}
          <button className="btn" type="submit" disabled={submitting || !name.trim()}>
            Save
          </button>
        </form>
      )}

      {tab === "members" && access.members && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 320, overflowY: "auto" }}>
          {memberError && <div className="error-text">{memberError}</div>}
          {community.members.map((m) => (
            <div key={m.id} className="friend-request-row">
              <Avatar user={m} size="sm" />
              <div className="grow">
                <div>{m.displayName}</div>
                <div className="hint">{m.identity}</div>
                {m.id !== community.owner.id && access.roles && (
                  <MemberRoles
                    community={community}
                    member={m}
                    onChanged={refreshCommunities}
                    viewerPermissions={viewerPermissions}
                  />
                )}
              </div>
              {m.id !== community.owner.id && m.id !== viewer.id && (
                <>
                  {access.kick && (
                    <button
                      className="btn-secondary"
                      style={{ fontSize: 11, padding: "2px 6px", borderRadius: 4 }}
                      onClick={() => setKicking(m)}
                    >
                      Kick
                    </button>
                  )}
                  {access.ban && (
                    <button
                      className="btn-danger"
                      style={{ fontSize: 11, padding: "2px 6px", borderRadius: 4 }}
                      onClick={() => setBanning(m)}
                    >
                      Ban
                    </button>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === "channels" && access.channels && <ChannelsPanel community={community} onChanged={refreshCommunities} />}

      {tab === "roles" && access.roles && (
        <RolesPanel community={community} onChanged={refreshCommunities} viewerPermissions={viewerPermissions} />
      )}

      {tab === "banned" && access.ban && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 320, overflowY: "auto" }}>
          {memberError && <div className="error-text">{memberError}</div>}
          {bans.length === 0 ? (
            <div className="empty-state">No banned users.</div>
          ) : (
            bans.map((b) => (
              <div key={b.user.id} className="friend-request-row">
                <Avatar user={b.user} size="sm" />
                <div className="grow">
                  <div>{b.user.displayName}</div>
                  <div className="hint">{b.reason || b.user.identity}</div>
                </div>
                <button
                  className="btn-secondary"
                  style={{ fontSize: 11, padding: "2px 6px", borderRadius: 4 }}
                  onClick={() => handleUnban(b)}
                >
                  Unban
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {kicking && (
        <ConfirmModal
          title="Kick member"
          message={`Kick ${kicking.displayName} from ${community.name}? They can rejoin later with the community ID.`}
          confirmLabel="Kick"
          danger
          onConfirm={() => handleKick(kicking)}
          onClose={() => setKicking(null)}
        />
      )}
      {banning && (
        <ConfirmModal
          title="Ban member"
          message={`Ban ${banning.displayName} from ${community.name}? They won't be able to rejoin until unbanned.`}
          confirmLabel="Ban"
          danger
          onConfirm={() => handleBan(banning)}
          onClose={() => setBanning(null)}
        />
      )}
    </Modal>
  );
}
