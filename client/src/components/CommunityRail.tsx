import { Link } from "react-router-dom";
import type { Community } from "../api";
import { TileFace, tileProps } from "./CommunityTile";
import { ChatIcon, CompassIcon, PlusIcon } from "./icons";

interface Props {
  communities: Community[];
  /** The community on screen, if any. */
  activeCommunityId: string | undefined;
  /** True on the Friends/DM side rather than inside a community. */
  atHome: boolean;
  /** True on the Browse page (the directory). */
  atBrowse?: boolean;
  /** Any DM or group chat with unread messages. */
  hasUnreadConversation: boolean;
  /** Friend requests waiting for an answer. */
  pendingRequestCount: number;
  onCreateCommunity: () => void;
}

/**
 * The far-left column. Home (friends and DMs) has its own shape and icon, a
 * separator divides it from the communities, and "create" is a dashed
 * outline so it can't be mistaken for a community. Only the community list
 * scrolls: Home and Create stay where they are.
 */
export default function CommunityRail({
  communities,
  activeCommunityId,
  atHome,
  atBrowse = false,
  hasUnreadConversation,
  pendingRequestCount,
  onCreateCommunity,
}: Props) {
  const homeLabel =
    pendingRequestCount > 0
      ? `Friends & DMs, ${pendingRequestCount} pending friend request${pendingRequestCount === 1 ? "" : "s"}`
      : hasUnreadConversation
        ? "Friends & DMs, unread messages"
        : "Friends & DMs";

  return (
    <nav className="rail" aria-label="Communities">
      <Link
        to="/friends"
        className={`rail-item rail-home ${atHome ? "active" : ""}`}
        title="Friends & DMs"
        aria-label={homeLabel}
        aria-current={atHome ? "page" : undefined}
      >
        <ChatIcon />
        {pendingRequestCount > 0 ? (
          <span className="rail-badge">{pendingRequestCount > 9 ? "9+" : pendingRequestCount}</span>
        ) : (
          hasUnreadConversation && <span className="rail-unread-dot" />
        )}
      </Link>

      <div className="rail-separator" role="separator" />

      <div className="rail-communities">
        {communities.map((c) => {
          const active = activeCommunityId === c.id;
          const hasUnread = c.channels.some((ch) => ch.unread);
          const tile = tileProps(c);
          return (
            <Link
              key={c.id}
              to={`/communities/${c.id}`}
              className={`rail-item rail-community ${active ? "active" : ""}${tile.className}`}
              style={tile.style}
              title={c.name}
              aria-label={hasUnread ? `${c.name}, unread messages` : c.name}
              aria-current={active ? "page" : undefined}
            >
              <TileFace community={c} />
              {hasUnread && <span className="rail-unread-dot" />}
            </Link>
          );
        })}
      </div>

      <button
        type="button"
        className="rail-item rail-add"
        onClick={onCreateCommunity}
        title="Create a community"
        aria-label="Create a community"
      >
        <PlusIcon />
      </button>
      <Link
        to="/browse"
        className={`rail-item rail-browse ${atBrowse ? "active" : ""}`}
        title="Browse communities"
        aria-label="Browse communities"
        aria-current={atBrowse ? "page" : undefined}
      >
        <CompassIcon />
      </Link>
    </nav>
  );
}
