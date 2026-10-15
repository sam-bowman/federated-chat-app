import type { PublicUser } from "../api";
import { mediaUrl } from "../api";

/**
 * A person's picture, or their first letter. The sizes are the --avatar-sm, --avatar-md and --avatar-xl
 * variables in index.css (sm in lists, md by default, xl where you manage your own picture), so a size
 * is decided in one place.
 */
export default function Avatar({
  user,
  size = "md",
}: {
  user: Pick<PublicUser, "displayName" | "avatarUrl">;
  size?: "sm" | "md" | "xl";
}) {
  const initial = user.displayName.trim().charAt(0).toUpperCase() || "?";
  const className = `avatar${size === "md" ? "" : ` ${size}`}`;
  if (user.avatarUrl) {
    return <img className={className} src={mediaUrl(user.avatarUrl)} alt={user.displayName} />;
  }
  return <div className={className}>{initial}</div>;
}
