import { createContext, useContext } from "react";
import type { PublicUser } from "../api";

export interface OpenProfileOptions {
  /** The community the person was clicked in: their roles there are shown, and its managers get Kick and Ban. */
  communityId?: string;
}

export interface UserProfileContextValue {
  openProfile: (user: PublicUser, options?: OpenProfileOptions) => void;
}

// Without a provider (a component under test, a page outside the app shell) clicking a person does nothing
// rather than failing.
export const UserProfileContext = createContext<UserProfileContextValue>({ openProfile: () => {} });

export function useUserProfile(): UserProfileContextValue {
  return useContext(UserProfileContext);
}
