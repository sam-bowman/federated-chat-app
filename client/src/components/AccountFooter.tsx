import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicUser } from "../api";
import { statusLabel, statusLine, type PresenceStatus } from "../lib/presence";
import Avatar from "./Avatar";
import PresenceDot from "./PresenceDot";
import StatusMenu, { STATUS_MENU_TRIGGER_ATTRIBUTE } from "./StatusMenu";
import { SettingsIcon, SignOutIcon } from "./icons";

interface Props {
  user: Pick<PublicUser, "displayName" | "avatarUrl" | "identity"> & {
    presence: { status: string; customStatus: string | null };
  };
  onOpenSettings: () => void;
  onSignOut: () => void;
  /** Applies a change to your own status and/or custom status, and refreshes the signed-in user. */
  onSetPresence: (patch: { status?: PresenceStatus; customStatus?: string | null }) => Promise<void>;
}

/**
 * The signed-in account at the bottom of the sidebar. Your status is always shown on it (a dot on the
 * avatar, and in words under your name with your custom status), and pressing the avatar or the status
 * opens a menu to change it without leaving the page. The identity gets its own row (truncated with the
 * full value in a tooltip, click to copy) so the buttons never sit on top of it.
 */
export default function AccountFooter({ user, onOpenSettings, onSignOut, onSetPresence }: Props) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [menuOpen, setMenuOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const statusButton = useRef<HTMLButtonElement>(null);
  const avatarButton = useRef<HTMLButtonElement>(null);
  // Which of the two controls opened the menu, so focus goes back to it.
  const openedFrom = useRef<HTMLElement | null>(null);

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

  function toggleMenu(from: HTMLElement) {
    openedFrom.current = from;
    setMenuOpen((open) => !open);
  }

  const closeMenu = useCallback((restoreFocus: boolean) => {
    setMenuOpen(false);
    if (restoreFocus) (openedFrom.current ?? statusButton.current)?.focus();
  }, []);

  function announce(message: string) {
    setAnnouncement(message);
  }

  const { status, customStatus } = user.presence;
  const description = `Status: ${statusLine(status)}${customStatus ? `, ${customStatus}` : ""}`;

  return (
    <div className="sidebar-footer">
      {/* A mouse shortcut to the same menu; the status line below is the keyboard and screen-reader way in. */}
      <button
        ref={avatarButton}
        type="button"
        className="account-avatar"
        tabIndex={-1}
        aria-hidden="true"
        title="Change status"
        {...{ [STATUS_MENU_TRIGGER_ATTRIBUTE]: "" }}
        onClick={(event) => toggleMenu(event.currentTarget)}
      >
        <Avatar user={user} size="sm" />
        <PresenceDot status={status} decorative />
      </button>
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
          ref={statusButton}
          type="button"
          className="account-status"
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
          aria-label={`${description}. Change status`}
          title={description}
          {...{ [STATUS_MENU_TRIGGER_ATTRIBUTE]: "" }}
          onClick={(event) => toggleMenu(event.currentTarget)}
        >
          <PresenceDot status={status} decorative />
          <span className="account-status-text">{statusLine(status)}</span>
          {customStatus && <span className="account-custom-status">{customStatus}</span>}
        </button>
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
          {copied ? "Identity copied to the clipboard" : announcement}
        </span>
      </div>

      {menuOpen && (
        <StatusMenu
          status={status}
          customStatus={customStatus}
          onSetStatus={async (next) => {
            await onSetPresence({ status: next });
            announce(`Status set to ${statusLabel(next)}`);
          }}
          onSetCustomStatus={async (next) => {
            await onSetPresence({ customStatus: next });
            announce(next === null ? "Custom status cleared" : "Custom status set");
          }}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}
