import { useState, type ReactNode } from "react";
import type { PublicUser } from "../api";
import { accentStyle, isHexColour, memberSinceText } from "../lib/profile";
import { statusLine } from "../lib/presence";
import Avatar from "./Avatar";
import PresenceDot from "./PresenceDot";

export interface ProfileRole {
  id: string;
  name: string;
  color: string | null;
}

interface Props {
  user: Pick<PublicUser, "identity" | "displayName" | "avatarUrl" | "bio" | "presence"> & {
    pronouns?: string | null;
    accentColor?: string | null;
  };
  /** When their account was created (ISO), if known. */
  memberSince?: string | null;
  /** Their roles in the community the profile was opened from. */
  roles?: ProfileRole[];
  /** A short note under the card, for example that the profile could not be fully loaded. */
  notice?: string | null;
  /** The actions for the relationship, when this card is in the profile dialog. */
  children?: ReactNode;
}

/**
 * Someone's profile as others see it: the same card in the profile dialog and in Settings' live preview, so they
 * cannot drift apart. Everything on it is someone else's text, shown as text only (never as HTML), and the accent
 * colour only ever reaches CSS as the --profile-accent custom property, and only as exactly #rrggbb.
 */
export default function ProfileCard({ user, memberSince, roles = [], notice, children }: Props) {
  const [copied, setCopied] = useState(false);
  const since = memberSinceText(memberSince);
  const status = statusLine(user.presence.status);

  async function copyIdentity() {
    try {
      await navigator.clipboard.writeText(user.identity);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // The clipboard can be unavailable (an insecure origin, a denied permission); the identity is still on screen.
    }
  }

  return (
    <section className="profile-card" style={accentStyle(user.accentColor)} aria-label={`Profile of ${user.displayName}`}>
      <div className="profile-banner" data-accent={isHexColour(user.accentColor) ? "custom" : "default"} />
      <div className="profile-head">
        <Avatar user={user} size="xl" />
        <div className="profile-names">
          <h2 className="profile-name">{user.displayName}</h2>
          {user.pronouns && <div className="profile-pronouns">{user.pronouns}</div>}
          <button
            type="button"
            className="profile-identity"
            title={`${user.identity} - click to copy`}
            aria-label={`Copy identity, ${user.identity}`}
            onClick={copyIdentity}
          >
            {user.identity}
          </button>
          <span className="sr-only" role="status" aria-live="polite">
            {copied ? "Identity copied to the clipboard" : ""}
          </span>
        </div>
      </div>

      <div className="profile-status">
        <PresenceDot status={user.presence.status} decorative />
        <span>
          {status}
          {user.presence.customStatus ? ` · ${user.presence.customStatus}` : ""}
        </span>
      </div>

      {user.bio && (
        <div className="profile-section">
          <h3 className="profile-section-title">About</h3>
          <p className="profile-bio">{user.bio}</p>
        </div>
      )}

      {(since || roles.length > 0) && (
        <div className="profile-section">
          {since && <div className="hint">{since}</div>}
          {roles.length > 0 && (
            <ul className="profile-roles" aria-label="Roles">
              {roles.map((role) => (
                <li
                  key={role.id}
                  className={`profile-role${role.color ? " profile-role-coloured" : ""}`}
                  style={isHexColour(role.color) ? ({ "--role-color": role.color } as React.CSSProperties) : undefined}
                >
                  {role.name}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {notice && (
        <p className="hint profile-notice" role="status">
          {notice}
        </p>
      )}
      {children && <div className="profile-actions">{children}</div>}
    </section>
  );
}
