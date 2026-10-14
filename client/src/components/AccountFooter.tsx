import { useEffect, useRef, useState } from "react";
import type { PublicUser } from "../api";
import Avatar from "./Avatar";
import { SettingsIcon, SignOutIcon } from "./icons";

interface Props {
  user: Pick<PublicUser, "displayName" | "avatarUrl" | "identity">;
  onOpenSettings: () => void;
  onSignOut: () => void;
}

/**
 * The signed-in account at the bottom of the sidebar. The identity gets its own
 * row (truncated with the full value in a tooltip, click to copy) so the buttons
 * never sit on top of it.
 */
export default function AccountFooter({ user, onOpenSettings, onSignOut }: Props) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  async function copyIdentity() {
    try {
      await navigator.clipboard.writeText(user.identity);
    } catch {
      // Clipboard can be unavailable (insecure origin, denied permission): the
      // full identity is still readable in the tooltip, so just don't claim success.
      return;
    }
    setCopied(true);
    clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="sidebar-footer">
      <Avatar user={user} size="sm" />
      <div className="account-details">
        <div className="account-name-row">
          <span className="account-name" title={user.displayName}>
            {user.displayName}
          </span>
          <button type="button" className="icon-button" aria-label="Settings" title="Settings" onClick={onOpenSettings}>
            <SettingsIcon />
          </button>
          <button type="button" className="icon-button danger" aria-label="Sign out" title="Sign out" onClick={onSignOut}>
            <SignOutIcon />
          </button>
        </div>
        <button
          type="button"
          className="account-identity"
          title={`${user.identity} - click to copy`}
          aria-label={`Copy your identity, ${user.identity}`}
          onClick={copyIdentity}
        >
          {copied ? "Copied!" : user.identity}
        </button>
        <span className="sr-only" role="status">
          {copied ? "Identity copied to the clipboard" : ""}
        </span>
      </div>
    </div>
  );
}
