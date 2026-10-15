import { useEffect, useMemo, useState } from "react";
import * as api from "../api";
import type { Community, PublicUser } from "../api";
import { useAppData } from "../context/AppDataContext";
import { inviteCode } from "../lib/invite";
import { noAutofill } from "../lib/noAutofill";
import { managementAccess } from "../lib/permissions";
import Avatar from "./Avatar";
import Button from "./Button";
import Modal from "./Modal";

type InviteState = "sending" | "sent" | "failed";

interface Props {
  community: Community;
  viewer: { id: string; identity: string };
  onClose: () => void;
}

/**
 * Inviting people to a community: the invite code, for anyone (another server, someone who is not
 * a friend yet), and the friends who are not in it yet, each with an Invite button that sends them
 * a direct message with a card they can join from.
 *
 * Banned friends are left out when the viewer is allowed to see the ban list; otherwise they cannot
 * be told apart here, and an invite to one simply cannot be accepted (its card says so).
 */
export default function InviteModal({ community, viewer, onClose }: Props) {
  const { friends } = useAppData();
  const code = inviteCode(community);
  const [copied, setCopied] = useState(false);
  const [filter, setFilter] = useState("");
  const [states, setStates] = useState<Record<string, InviteState>>({});
  const [bannedIds, setBannedIds] = useState<Set<string>>(new Set());

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

  const memberIds = useMemo(() => new Set(community.members.map((m) => m.id)), [community.members]);
  const invitable = friends.filter((f) => !memberIds.has(f.id) && !bannedIds.has(f.id));
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? invitable.filter((f) => `${f.displayName} ${f.identity}`.toLowerCase().includes(needle))
    : invitable;

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard access: the code is in the box above, selected on focus, to copy by hand.
      setCopied(false);
    }
  }

  async function invite(friend: PublicUser) {
    setStates((s) => ({ ...s, [friend.id]: "sending" }));
    try {
      await api.inviteToCommunity(community.id, friend);
      setStates((s) => ({ ...s, [friend.id]: "sent" }));
    } catch {
      setStates((s) => ({ ...s, [friend.id]: "failed" }));
    }
  }

  return (
    <Modal title={`Invite to ${community.name}`} onClose={onClose} width={460}>
      <div className="invite-section">
        <label className="hint" htmlFor="invite-code">
          Invite code
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
          <Button variant="secondary" onClick={() => void copyCode()}>
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <div className="hint" role="status">
          {copied
            ? "Copied to the clipboard."
            : "Anyone with this code can join, on this server or another one: they paste it under New community, Join by ID."}
        </div>
      </div>

      <div className="invite-section">
        <label className="hint" htmlFor="invite-filter">
          Invite a friend
        </label>
        {invitable.length > 0 && (
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
          {friends.length === 0 ? (
            <div className="empty-state">You have no friends to invite yet. Share the invite code instead.</div>
          ) : invitable.length === 0 ? (
            <div className="empty-state">All your friends are already in {community.name}.</div>
          ) : shown.length === 0 ? (
            <div className="empty-state">No friend matches.</div>
          ) : (
            shown.map((friend) => {
              const state = states[friend.id];
              return (
                <div key={friend.id} className="friend-request-row">
                  <Avatar user={friend} size="sm" />
                  <div className="grow">
                    <div>{friend.displayName}</div>
                    <div className="hint">{friend.identity}</div>
                  </div>
                  {state === "failed" && <span className="error-text">Couldn't send</span>}
                  <Button
                    size="sm"
                    variant={state === "sent" ? "secondary" : "primary"}
                    busy={state === "sending"}
                    disabled={state === "sent"}
                    aria-label={`Invite ${friend.displayName}`}
                    onClick={() => void invite(friend)}
                  >
                    {state === "sent" ? "Invited" : state === "failed" ? "Try again" : "Invite"}
                  </Button>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
      </div>
    </Modal>
  );
}
