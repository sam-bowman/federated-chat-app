import { useCallback, useEffect, useState } from "react";
import * as api from "../api";
import type { Community, CommunityBan } from "../api";
import { managementAccess, viewerPermissions as permissionsOf } from "../lib/permissions";
import { useAppData } from "../context/AppDataContext";
import Avatar from "./Avatar";
import CommunityDangerZone from "./CommunityDangerZone";
import MemberModerationActions from "./MemberModerationActions";
import UserLink from "./UserLink";
import Modal from "./Modal";
import RolesPanel from "./RolesPanel";
import ChannelsPanel from "./ChannelsPanel";
import MemberRoles from "./MemberRoles";
import { noAutofill } from "../lib/noAutofill";
import Button from "./Button";
import Tabs from "./Tabs";
import CommunityIconSettings from "./CommunityIconSettings";
import CommunityJoinSettings from "./CommunityJoinSettings";
import AuditLogList from "./AuditLogList";
import ReportsQueue from "./ReportsQueue";

type Tab = "general" | "members" | "channels" | "roles" | "banned" | "reports" | "audit";

interface Props {
  community: Community;
  /** Who is looking: decides which tabs and controls appear (the server still checks every request). */
  viewer: { id: string; identity: string; directoryEnabled?: boolean };
  onClose: () => void;
  /** How many reports are waiting (null when not known or not a reviewer), and where the queue says the number when it changes. */
  reportsWaiting?: number | null;
  onReportsWaiting?: (open: number) => void;
}

export default function CommunitySettingsModal({ community, viewer, onClose, reportsWaiting = null, onReportsWaiting }: Props) {
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
    // The reports members made about messages here, for whoever holds the Review reports permission (the server decides too).
    ...(access.reports ? [{ id: "reports" as const, label: reportsWaiting ? `Reports (${reportsWaiting})` : "Reports" }] : []),
    // What the managers did, for those who manage the community (the server decides too).
    ...(access.general ? [{ id: "audit" as const, label: "Audit log" }] : []),
  ];
  const [chosenTab, setChosenTab] = useState<Tab>(tabs[0]?.id ?? "general");
  // If a role change takes the chosen tab away while the modal is open, fall back to one still allowed.
  const tab = tabs.some((t) => t.id === chosenTab) ? chosenTab : (tabs[0]?.id ?? chosenTab);

  const [name, setName] = useState(community.name);
  const [description, setDescription] = useState(community.description ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadAudit = useCallback((query: api.AuditQuery) => api.getCommunityAuditLog(community.id, query), [community.id]);
  const [bans, setBans] = useState<CommunityBan[]>([]);
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
    <Modal title="Community settings" onClose={onClose} width={680}>
      <Tabs label="Community settings" tabs={tabs} value={tab} onChange={setChosenTab} minHeight="20rem">
        {tab === "general" && access.general && (
          <>
            <CommunityIconSettings community={community} />
            <CommunityJoinSettings community={community} directoryPublished={viewer.directoryEnabled !== false} />
            <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.625rem" }}>
              <label className="hint">Name</label>
              <input {...noAutofill} value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
              <label className="hint">Description</label>
              <textarea {...noAutofill} value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
              {error && <div className="error-text">{error}</div>}
              <Button type="submit" disabled={submitting || !name.trim()}>
                Save
              </Button>
            </form>
            {/* Outside the form: its dialogs contain forms of their own, and a submit must not reach this one. */}
            <CommunityDangerZone community={community} viewer={viewer} onFinished={onClose} />
          </>
        )}

        {tab === "members" && access.members && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.375rem", maxHeight: "20rem", overflowY: "auto" }}>
            {memberError && <div className="error-text">{memberError}</div>}
            {community.members.map((m) => (
              <div key={m.id} className="friend-request-row">
                <UserLink user={m} communityId={community.id} label={`View ${m.displayName}'s profile`} className="user-link-avatar">
                  <Avatar user={m} size="sm" />
                </UserLink>
                <div className="grow">
                  <div>
                    <UserLink user={m} communityId={community.id}>
                      <span className="user-link-name">{m.displayName}</span>
                    </UserLink>
                  </div>
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
                  <MemberModerationActions community={community} member={m} can={access} onError={setMemberError} />
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
          <div style={{ display: "flex", flexDirection: "column", gap: "0.375rem", maxHeight: "20rem", overflowY: "auto" }}>
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
                  <Button
                    onClick={() => handleUnban(b)}
                    variant="secondary"
                    size="sm"
                  >
                    Unban
                  </Button>
                </div>
              ))
            )}
          </div>
        )}

        {tab === "reports" && access.reports && (
          <>
            <p className="hint">
              Reports members made about messages in this community. Only people with the Review reports permission see them, and the person
              reported is never told. A report about you is not shown to you.
            </p>
            <ReportsQueue communityId={community.id} onOpenChange={onReportsWaiting} />
          </>
        )}

        {tab === "audit" && access.general && (
          <>
            <p className="hint">What was done to run this community: kicks, bans, roles, channels, settings. It never shows what anyone wrote.</p>
            <AuditLogList load={loadAudit} scope="community" />
          </>
        )}
      </Tabs>
    </Modal>
  );
}
