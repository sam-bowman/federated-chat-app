import { useCallback, useEffect, useId, useMemo, useState } from "react";
import * as api from "../api";
import { ApiError } from "../api/client";
import type { Community, Invite, PublicUser } from "../api";
import { useAppData } from "../context/AppDataContext";
import {
  INVITE_EXPIRY_CHOICES,
  INVITE_STATUS_LABELS,
  INVITE_USE_CHOICES,
  inviteCode,
  inviteExpiryText,
  inviteLimitText,
  inviteUsesText,
  isOpenToAnyone,
} from "../lib/invite";
import { noAutofill } from "../lib/noAutofill";
import { canCreateInvites, domainOf, managementAccess } from "../lib/permissions";
import { isOnAnotherServer, useFederationEnabled } from "../lib/federation";
import Avatar from "./Avatar";
import Button from "./Button";
import ConfirmModal from "./ConfirmModal";
import Modal from "./Modal";

type FriendState = "sending" | "sent" | "failed";

interface Props {
  community: Community;
  viewer: { id: string; identity: string };
  onClose: () => void;
}

/**
 * Inviting people to a community.
 *  - **Invites**: a code you make with an expiry and a limit on how many people can use it, listed with its uses, and
 *    revoked when you want it to stop. Anyone with the code can join, on this server or another.
 *  - **The community code**: the permanent one (the id and the server). It only lets people in while the community is open
 *    to anyone; when it is invite-only the code is not shown, since it would not work.
 *  - **Friends**: each gets a direct message with a card that carries an invite of its own (one use, a week).
 *
 * The list of invites and revoking them are the community's home server's: for a community on another server you can make
 * an invite (the home server does it) but not list or revoke it from here. You see your own invites, or everyone's if you can
 * manage the community. Banned friends are left out when the viewer may see the ban list; otherwise they cannot be told apart
 * here, and an invitation to one simply cannot be accepted (its card says so).
 */
export default function InviteModal({ community, viewer, onClose }: Props) {
  const { friends } = useAppData();
  const federating = useFederationEnabled();
  const code = inviteCode(community);
  const open = isOpenToAnyone(community);
  // The invites live on the community's home server; only someone on that server can list and revoke them.
  const isHome = domainOf(viewer.identity) === community.homeserverDomain.toLowerCase();
  // Whether to offer making invites. On the home server the viewer's roles are known, so the permission decides. For a community
  // on another server they are not (that server sends the community's structure, never its roles), so the home server is the
  // one to say: it is asked, and a refusal is reported.
  const canCreate = isHome ? canCreateInvites(community, viewer) : true;

  const [copied, setCopied] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [states, setStates] = useState<Record<string, FriendState>>({});
  const [bannedIds, setBannedIds] = useState<Set<string>>(new Set());

  const [expiry, setExpiry] = useState<number | null>(604_800);
  const [maxUses, setMaxUses] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [made, setMade] = useState<Invite | null>(null);

  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [seesAll, setSeesAll] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [revoking, setRevoking] = useState<Invite | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const expiryId = useId();
  const usesId = useId();

  const canSeeBans = managementAccess(community, viewer).ban;
  useEffect(() => {
    if (!canSeeBans) return;
    let current = true;
    api
      .listCommunityBans(community.id)
      .then((bans) => current && setBannedIds(new Set(bans.map((b) => b.user.id))))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [canSeeBans, community.id]);

  useEffect(() => {
    if (!isHome) return;
    let current = true;
    api
      .listInvites(community.id)
      .then((result) => {
        if (!current) return;
        setInvites(result.invites);
        setSeesAll(result.seesAll);
        setListError(null);
      })
      .catch(() => current && setListError("Couldn't load the invites."));
    return () => {
      current = false;
    };
  }, [isHome, community.id, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);

  const memberIds = useMemo(() => new Set(community.members.map((m) => m.id)), [community.members]);
  const invitable = friends.filter((f) => !memberIds.has(f.id) && !bannedIds.has(f.id));
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? invitable.filter((f) => `${f.displayName} ${f.identity}`.toLowerCase().includes(needle))
    : invitable;

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((current) => (current === key ? null : current)), 2000);
    } catch {
      // No clipboard access: the code is in the box, selected on focus, to copy by hand.
      setCopied(null);
    }
  }

  async function create() {
    setCreating(true);
    setCreateError(null);
    try {
      const invite = await api.createInvite(community.id, { expiresInSeconds: expiry, maxUses });
      setMade(invite);
      if (isHome) reload();
    } catch (err) {
      const refused = err instanceof ApiError && err.status === 403;
      setCreateError(refused ? "You don't have permission to create invites in this community." : "Couldn't make an invite. Try again.");
    } finally {
      setCreating(false);
    }
  }

  async function revoke(invite: Invite) {
    if (invite.id === null) return;
    setRevokeError(null);
    try {
      await api.revokeInvite(community.id, invite.id);
      if (made?.id === invite.id) setMade(null);
      reload();
    } catch {
      setRevokeError("Couldn't revoke that invite.");
    }
  }

  async function inviteFriend(friend: PublicUser) {
    setStates((s) => ({ ...s, [friend.id]: "sending" }));
    try {
      await api.inviteToCommunity(community.id, friend);
      setStates((s) => ({ ...s, [friend.id]: "sent" }));
    } catch {
      setStates((s) => ({ ...s, [friend.id]: "failed" }));
    }
  }

  return (
    <Modal title={`Invite to ${community.name}`} onClose={onClose} width={520}>
      <div className="invite-section">
        <div className="hint">Invites</div>
        {canCreate ? (
          <>
            <div className="invite-options">
              <div className="invite-option">
                <label className="hint" htmlFor={expiryId}>
                  Expires after
                </label>
                <select id={expiryId} value={String(expiry)} onChange={(e) => setExpiry(e.target.value === "null" ? null : Number(e.target.value))}>
                  {INVITE_EXPIRY_CHOICES.map((choice) => (
                    <option key={String(choice.value)} value={String(choice.value)}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="invite-option">
                <label className="hint" htmlFor={usesId}>
                  Limit
                </label>
                <select id={usesId} value={String(maxUses)} onChange={(e) => setMaxUses(e.target.value === "null" ? null : Number(e.target.value))}>
                  {INVITE_USE_CHOICES.map((choice) => (
                    <option key={String(choice.value)} value={String(choice.value)}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              </div>
              <Button busy={creating} onClick={() => void create()}>
                Create invite
              </Button>
            </div>
            {createError && (
              <div className="error-text" role="alert">
                {createError}
              </div>
            )}
            {made && (
              <div className="invite-made">
                <label className="hint" htmlFor="new-invite">
                  New invite
                </label>
                <div className="invite-code-row">
                  <input
                    {...noAutofill}
                    id="new-invite"
                    name="new-invite"
                    readOnly
                    value={made.reference}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <Button variant="secondary" aria-label="Copy invite" onClick={() => void copy(made.reference, "made")}>
                    {copied === "made" ? "Copied" : "Copy"}
                  </Button>
                </div>
                <div className="hint" role="status">
                  {copied === "made"
                    ? "Copied to the clipboard."
                    : `${inviteExpiryText(made.expiresAt)} · ${inviteLimitText(made.maxUses)} can use it. Paste it under New community, Join by ID.`}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="hint">You don't have permission to create invites in this community.</div>
        )}

        {isHome ? (
          <div className="invite-list">
            <div className="hint">{seesAll ? "All invites" : "Your invites"}</div>
            {listError && (
              <div className="error-text" role="alert">
                {listError}
              </div>
            )}
            {revokeError && (
              <div className="error-text" role="alert">
                {revokeError}
              </div>
            )}
            {invites === null && !listError ? (
              <div className="hint">Loading…</div>
            ) : invites !== null && invites.length === 0 ? (
              <div className="empty-state">No invites yet.</div>
            ) : (
              invites?.map((invite) => (
                <div key={invite.id} className={`friend-request-row invite-row${invite.status === "active" ? "" : " invite-row-ended"}`}>
                  <div className="grow">
                    <div>
                      <code className="invite-code-text">{invite.code}</code>{" "}
                      <span className={`invite-status invite-status-${invite.status}`}>{INVITE_STATUS_LABELS[invite.status]}</span>
                    </div>
                    <div className="hint">
                      {/* The badge already says why an ended invite ended; its expiry would only contradict it. */}
                      {invite.status === "active" ? `${inviteExpiryText(invite.expiresAt)} · ` : ""}
                      {inviteUsesText(invite)}
                      {seesAll && invite.createdBy.id !== viewer.id ? ` · by ${invite.createdBy.displayName}` : ""}
                    </div>
                  </div>
                  {invite.status === "active" && (
                    <>
                      <Button size="sm" variant="secondary" aria-label={`Copy invite ${invite.code}`} onClick={() => void copy(invite.reference, invite.code)}>
                        {copied === invite.code ? "Copied" : "Copy"}
                      </Button>
                      <Button size="sm" variant="danger" aria-label={`Revoke invite ${invite.code}`} onClick={() => setRevoking(invite)}>
                        Revoke
                      </Button>
                    </>
                  )}
                </div>
              ))
            )}
          </div>
        ) : (
          <div className="hint">
            Invites are listed and revoked on {community.homeserverDomain}, where this community lives. Anyone who manages it there can see them.
          </div>
        )}
      </div>

      <div className="invite-section">
        {open ? (
          <>
            <label className="hint" htmlFor="invite-code">
              Community code
            </label>
            <div className="invite-code-row">
              <input
                {...noAutofill}
                id="invite-code"
                name="invite-code"
                readOnly
                value={code}
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button variant="secondary" aria-label="Copy community code" onClick={() => void copy(code, "code")}>
                {copied === "code" ? "Copied" : "Copy"}
              </Button>
            </div>
            <div className="hint" role="status">
              {copied === "code"
                ? "Copied to the clipboard."
                : "Never expires, and anyone with it can join, on this server or another one: they paste it under New community, Join by ID. Make this community invite-only in its settings to stop that."}
            </div>
          </>
        ) : (
          <>
            <div className="hint">Community code</div>
            <div className="hint">
              This community is invite-only, so its community code lets no one in. Make an invite above, or invite a friend below.
            </div>
          </>
        )}
      </div>

      <div className="invite-section">
        <label className="hint" htmlFor="invite-filter">
          Invite a friend
        </label>
        {canCreate && invitable.length > 0 && (
          <input
            {...noAutofill}
            id="invite-filter"
            name="invite-filter"
            type="search"
            aria-label="Search friends"
            placeholder="Search friends"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        )}
        <div className="invite-friends">
          {!canCreate ? (
            <div className="empty-state">You can't invite friends here without permission to create invites.</div>
          ) : friends.length === 0 ? (
            <div className="empty-state">You have no friends to invite yet. Share an invite instead.</div>
          ) : invitable.length === 0 ? (
            <div className="empty-state">All your friends are already in {community.name}.</div>
          ) : shown.length === 0 ? (
            <div className="empty-state">No friend matches.</div>
          ) : (
            shown.map((friend) => {
              const state = states[friend.id];
              // A private server cannot send anything to someone on another one.
              const unreachable = !federating && isOnAnotherServer(friend.identity, viewer.identity);
              return (
                <div key={friend.id} className="friend-request-row">
                  <Avatar user={friend} size="sm" />
                  <div className="grow">
                    <div>{friend.displayName}</div>
                    <div className="hint">{unreachable ? `${friend.identity} (another server)` : friend.identity}</div>
                  </div>
                  {state === "failed" && <span className="error-text">Couldn't send</span>}
                  <Button
                    size="sm"
                    variant={state === "sent" ? "secondary" : "primary"}
                    busy={state === "sending"}
                    disabled={state === "sent" || unreachable}
                    aria-label={`Invite ${friend.displayName}`}
                    onClick={() => void inviteFriend(friend)}
                  >
                    {state === "sent" ? "Invited" : state === "failed" ? "Try again" : "Invite"}
                  </Button>
                </div>
              );
            })
          )}
        </div>
        {canCreate && <div className="hint">Sends a direct message with an invitation that can be used once and lasts a week.</div>}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
      </div>

      {revoking && (
        <ConfirmModal
          title="Revoke invite"
          message={`Revoke invite ${revoking.code}? Anyone who has it can no longer join with it. People who already joined stay.`}
          confirmLabel="Revoke"
          danger
          onConfirm={() => void revoke(revoking)}
          onClose={() => setRevoking(null)}
        />
      )}
    </Modal>
  );
}
