import { useState } from "react";
import { createPortal } from "react-dom";
import * as api from "../api";
import type { Community, PublicUser } from "../api";
import { useAppData } from "../context/AppDataContext";
import Button from "./Button";
import ConfirmModal from "./ConfirmModal";

interface Props {
  community: Community;
  member: Pick<PublicUser, "id" | "displayName">;
  /** Which of the two the viewer may do (from `managementAccess`); a button is only shown for what is allowed. */
  can: { kick: boolean; ban: boolean };
  /** The buttons' size: small in the member list, the usual size beside a profile's other actions. */
  size?: "sm" | "md";
  /** Called with a message when it fails, and with null when a new attempt starts. */
  onError?: (message: string | null) => void;
  /** Called after a kick or ban went through, once the community has been reloaded. */
  onDone?: () => void;
}

/**
 * The Kick and Ban buttons for one member, each behind its confirmation. Used by the Members tab of community
 * settings and by the profile dialog, so both ask the same question and make the same request. The server
 * checks the permission on every request; hiding a button here only keeps it from being offered.
 */
export default function MemberModerationActions({ community, member, can, size = "sm", onError, onDone }: Props) {
  const { refreshCommunities } = useAppData();
  const [confirming, setConfirming] = useState<"kick" | "ban" | null>(null);

  async function act(kind: "kick" | "ban") {
    onError?.(null);
    try {
      await (kind === "kick" ? api.kickMember(community.id, member.id) : api.banMember(community.id, member.id));
      await refreshCommunities();
      onDone?.();
    } catch {
      onError?.(`Couldn't ${kind} ${member.displayName}.`);
    }
  }

  return (
    <>
      {can.kick && (
        <Button onClick={() => setConfirming("kick")} variant="secondary" size={size}>
          Kick
        </Button>
      )}
      {can.ban && (
        <Button onClick={() => setConfirming("ban")} variant="danger" size={size}>
          Ban
        </Button>
      )}
      {/* In a portal so the question is the topmost dialog whichever dialog the buttons are in. */}
      {confirming &&
        createPortal(
          <ConfirmModal
            title={confirming === "kick" ? "Kick member" : "Ban member"}
            message={
              confirming === "kick"
                ? `Kick ${member.displayName} from ${community.name}? They can rejoin later with the community ID.`
                : `Ban ${member.displayName} from ${community.name}? They won't be able to rejoin until unbanned.`
            }
            confirmLabel={confirming === "kick" ? "Kick" : "Ban"}
            danger
            onConfirm={() => void act(confirming)}
            onClose={() => setConfirming(null)}
          />,
          document.body
        )}
    </>
  );
}
