import type { ReactNode } from "react";
import type { PublicUser } from "../api";
import { useUserProfile } from "../context/userProfile";

interface Props {
  user: PublicUser;
  /** Pass the community when the person is shown inside one, so their roles there appear on the profile. */
  communityId?: string;
  /** Names the control when its content is only a picture, for example "View Sam's profile". */
  label?: string;
  className?: string;
  children: ReactNode;
}

/**
 * Wraps a person's avatar or name so that pressing it opens their profile. Every place that shows a person
 * uses this, so they all behave the same way (and with the keyboard: it is a real button).
 */
export default function UserLink({ user, communityId, label, className, children }: Props) {
  const { openProfile } = useUserProfile();
  return (
    <button
      type="button"
      className={`user-link${className ? ` ${className}` : ""}`}
      aria-label={label}
      aria-haspopup="dialog"
      onClick={() => openProfile(user, { communityId })}
    >
      {children}
    </button>
  );
}
