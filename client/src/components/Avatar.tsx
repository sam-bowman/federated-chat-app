import type { PublicUser } from "../api";
import { mediaUrl } from "../api";

export default function Avatar({ user, size = "md" }: { user: Pick<PublicUser, "displayName" | "avatarUrl">; size?: "sm" | "md" }) {
  const initial = user.displayName.trim().charAt(0).toUpperCase() || "?";
  const className = `avatar${size === "sm" ? " sm" : ""}`;
  if (user.avatarUrl) {
    return <img className={className} src={mediaUrl(user.avatarUrl)} alt={user.displayName} />;
  }
  return <div className={className}>{initial}</div>;
}
