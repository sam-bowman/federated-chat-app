import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as api from "../api";
import type { PublicUser, UserProfile } from "../api";
import { ApiError } from "../api/client";
import { useAppData } from "../context/AppDataContext";
import { useAuth } from "../context/AuthContext";
import { managementAccess } from "../lib/permissions";
import { contactRefusalMessage, isContactRefusal } from "../lib/contact";
import { federationRefusalMessage } from "../lib/federation";
import Button from "./Button";
import ConfirmModal from "./ConfirmModal";
import MemberModerationActions from "./MemberModerationActions";
import Modal from "./Modal";
import ProfileCard, { type ProfileRole } from "./ProfileCard";

interface Props {
  /** Who was clicked, as the page that showed them knew them: shown at once, while the full profile loads. */
  user: PublicUser;
  communityId?: string;
  onClose: () => void;
}

type Load =
  | { state: "loading"; previous: UserProfile | null }
  | { state: "ready"; profile: UserProfile }
  | { state: "unavailable" }
  | { state: "failed"; previous: UserProfile | null };

/**
 * Why the server refused to start this with the person (it is private, does not talk to their server, or their own setting does
 * not let you), in words, or null if that is not why it failed.
 */
function startRefusal(err: unknown, what: "request" | "conversation"): string | null {
  if (!(err instanceof ApiError)) return null;
  const code = (err.body as { error?: string } | null)?.error;
  return isContactRefusal(code) ? contactRefusalMessage(what) : federationRefusalMessage(code);
}

/** The profile a state was showing, so a reload does not blank the dialog. */
function profileOf(load: Load): UserProfile | null {
  if (load.state === "ready") return load.profile;
  return load.state === "loading" || load.state === "failed" ? load.previous : null;
}

/**
 * Someone's profile: the card (picture, name, identity, status, bio, pronouns, how long they have been here and,
 * if opened from a community, their roles in it) and the actions that make sense for how you relate to them.
 * It shows what is already known straight away and fills in the rest from the server; for someone on another
 * server that is their own server's answer, or the copy we had if it cannot be reached.
 */
export default function UserProfileModal({ user, communityId, onClose }: Props) {
  const { user: viewer } = useAuth();
  const { communities, refreshConversations, refreshFriends, refreshRequests } = useAppData();
  const navigate = useNavigate();
  const [load, setLoad] = useState<Load>({ state: "loading", previous: null });
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmingBlock, setConfirmingBlock] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getUserProfile(user.id)
      .then((profile) => {
        if (!cancelled) setLoad({ state: "ready", profile });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) setLoad({ state: "unavailable" });
        else setLoad((current) => ({ state: "failed", previous: profileOf(current) }));
      });
    return () => {
      cancelled = true;
    };
  }, [user.id, version]);

  const profile = profileOf(load);
  const shown = profile?.user ?? user;
  const relationship = profile?.relationship;
  const isSelf = relationship?.isSelf ?? viewer?.id === user.id;

  const community = communityId ? communities.find((c) => c.id === communityId) : undefined;
  const member = community?.members.find((m) => m.id === user.id);
  const roles: ProfileRole[] = [];
  if (community && member) {
    if (community.owner.id === member.id) roles.push({ id: "owner", name: "Owner", color: null });
    for (const role of community.roles) {
      if (!role.isDefault && member.roleIds.includes(role.id)) roles.push({ id: role.id, name: role.name, color: role.color });
    }
  }
  const moderation =
    community && member && viewer && !isSelf && community.owner.id !== member.id ? managementAccess(community, viewer) : null;

  const notice =
    load.state === "unavailable"
      ? "This profile isn't available."
      : load.state === "failed"
        ? "Couldn't load the full profile."
        : profile && !profile.homeServerReachable
          ? "Their server couldn't be reached, so this may be out of date."
          : load.state === "loading" && !profile
            ? "Loading…"
            : null;

  // Keeps showing what was loaded while it loads again, so the dialog does not flash after an action.
  const reload = useCallback(() => {
    setLoad((current) => ({ state: "loading", previous: profileOf(current) }));
    setVersion((v) => v + 1);
  }, []);

  async function run(action: () => Promise<unknown>, failure: string) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      await Promise.all([refreshFriends(), refreshRequests()]);
      reload();
    } catch (err) {
      setActionError(startRefusal(err, "request") ?? failure);
    } finally {
      setBusy(false);
    }
  }

  async function message() {
    setBusy(true);
    setActionError(null);
    try {
      const conversation = await api.createConversation("DM", [shown.identity]);
      await refreshConversations();
      onClose();
      navigate(`/dm/${conversation.id}`);
    } catch (err) {
      setActionError(startRefusal(err, "conversation") ?? "Couldn't open a conversation with them.");
      setBusy(false);
    }
  }

  return (
    <Modal title="Profile" onClose={onClose} width={440}>
      <ProfileCard user={shown} memberSince={profile?.memberSince} roles={roles} notice={notice}>
        {actionError && (
          <div className="error-text" role="alert">
            {actionError}
          </div>
        )}
        {isSelf ? (
          <Button
            onClick={() => {
              onClose();
              navigate("/settings");
            }}
          >
            Edit profile
          </Button>
        ) : (
          relationship && (
            <>
              {!relationship.blockedByMe && (
                <Button onClick={() => void message()} disabled={busy}>
                  Message
                </Button>
              )}
              {!relationship.blockedByMe &&
                (relationship.isFriend ? (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void run(() => api.removeFriend(shown.id), "Couldn't remove them as a friend.")}
                  >
                    Remove friend
                  </Button>
                ) : relationship.pendingRequest?.direction === "outgoing" ? (
                  <Button variant="secondary" disabled>
                    Request sent
                  </Button>
                ) : relationship.pendingRequest?.direction === "incoming" ? (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void run(() => api.acceptFriendRequest(relationship.pendingRequest!.id), "Couldn't accept the request.")}
                  >
                    Accept friend request
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void run(() => api.sendFriendRequest(shown.identity), "Couldn't send the request.")}
                  >
                    Add friend
                  </Button>
                ))}
              {relationship.blockedByMe && (
                <Button variant="secondary" disabled={busy} onClick={() => void run(() => api.unblockUser(shown.id), "Couldn't unblock them.")}>
                  Unblock
                </Button>
              )}
              {relationship.canBlock && !relationship.blockedByMe && (
                <Button variant="danger" disabled={busy} onClick={() => setConfirmingBlock(true)}>
                  Block
                </Button>
              )}
            </>
          )
        )}
        {community && member && moderation && (moderation.kick || moderation.ban) && (
          <MemberModerationActions community={community} member={member} can={moderation} size="md" onError={setActionError} onDone={onClose} />
        )}
      </ProfileCard>
      {confirmingBlock && (
        <ConfirmModal
          title="Block user"
          message={`Block ${shown.displayName}? They are removed from your friends, and can't send you friend requests or messages.`}
          confirmLabel="Block"
          danger
          onConfirm={() => void run(() => api.blockUser(shown.username), "Couldn't block them.")}
          onClose={() => setConfirmingBlock(false)}
        />
      )}
    </Modal>
  );
}
