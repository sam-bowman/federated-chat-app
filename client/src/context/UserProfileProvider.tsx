import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { PublicUser } from "../api";
import UserProfileModal from "../components/UserProfileModal";
import { UserProfileContext, type OpenProfileOptions } from "./userProfile";

/**
 * Lets any component open someone's profile (`useUserProfile().openProfile(user)`), and renders the one profile
 * dialog. It sits inside the app data, so the dialog can read communities and refresh friends, and after the
 * app shell, so it is later in the page than the dialogs the shell opens and therefore the topmost.
 */
export function UserProfileProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<{ user: PublicUser; options: OpenProfileOptions } | null>(null);
  const openProfile = useCallback((user: PublicUser, options: OpenProfileOptions = {}) => setOpen({ user, options }), []);
  const value = useMemo(() => ({ openProfile }), [openProfile]);

  return (
    <UserProfileContext.Provider value={value}>
      {children}
      {open && <UserProfileModal key={open.user.id} user={open.user} communityId={open.options.communityId} onClose={() => setOpen(null)} />}
    </UserProfileContext.Provider>
  );
}
