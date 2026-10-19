import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import * as api from "../api";
import type { PublicUser, TotpChallenge } from "../api";
import {
  clearHomeServer as clearHomeServerClient,
  clearTokens,
  getHomeServer,
  isFixedServerMode,
  setHomeServer as setHomeServerClient,
  SYNC_CURSOR_KEY,
  type HomeServer,
} from "../api/client";
import { discoverHomeServer, parseServerInput } from "../api/discovery";
import { domainOf } from "../lib/permissions";
import { refreshRememberedServer, rememberAccount } from "../lib/recentAccounts";

interface AuthContextValue {
  user: PublicUser | null;
  loading: boolean;
  /** The server this client is currently pointed at - null only in picker mode, before anything's been resolved. */
  homeServer: HomeServer | null;
  isFixedServerMode: boolean;
  /** Resolves to a TotpChallenge instead of setting the session when the account has 2FA enabled - see verifyTotpLogin. */
  login: (username: string, password: string) => Promise<TotpChallenge | void>;
  verifyTotpLogin: (challengeToken: string, input: { code?: string; recoveryCode?: string }) => Promise<void>;
  register: (username: string, password: string, displayName?: string, inviteCode?: string) => Promise<void>;
  logout: () => void;
  refreshUser: () => Promise<void>;
  /** Parses + discovers `input`, clears any existing session only if it resolves to a different server. */
  resolveHomeServer: (input: string) => Promise<HomeServer>;
  /** Explicit "use a different server" action - clears both the session and the remembered server. No-op in fixed mode. */
  switchServer: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Offer this identity again next time. Called only after a sign-in actually succeeded. */
function recordSignIn(user: PublicUser) {
  const server = getHomeServer();
  if (!server) return;
  const domain = user.identity ? domainOf(user.identity) : server.domain;
  if (!domain) return;
  rememberAccount({
    origin: server.origin,
    // From the person's own identity, which the server just answered with: the address the API is reached at can be a
    // different host from the one in an id, and discovery may not have finished (or may have failed) at this point.
    domain,
    serverName: server.serverName,
    username: user.username,
  });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [homeServer, setHomeServerState] = useState<HomeServer | null>(() => getHomeServer());

  useEffect(() => {
    if (isFixedServerMode()) {
      // Best-effort only - this is purely to learn the real domain/serverName
      // for display (fixes a bug where the identity preview always showed
      // "localhost" regardless of the actual configured domain). Never
      // gates `loading`, and a failure just leaves the UI falling back to
      // the origin's hostname (see AuthPage.tsx).
      const current = getHomeServer();
      if (current) {
        discoverHomeServer({ domainOrOrigin: current.origin })
          .then((resolved) => {
            setHomeServerClient(resolved);
            setHomeServerState(resolved);
          })
          .catch(() => {
            // Stay on the origin-only placeholder set at module init.
          });
      }
    } else if (!getHomeServer()) {
      // Picker mode, fresh client (or one that's never resolved a server) -
      // there's nothing to restore a session against yet.
      setLoading(false);
      return;
    }

    if (!api.getAccessToken()) {
      setLoading(false);
      return;
    }
    api
      .me()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = async (username: string, password: string) => {
    const result = await api.login(username, password);
    if ("totpRequired" in result) {
      return result;
    }
    setUser(result);
    recordSignIn(result);
  };

  const verifyTotpLogin = async (challengeToken: string, input: { code?: string; recoveryCode?: string }) => {
    const signedIn = await api.verifyTotpLogin(challengeToken, input);
    setUser(signedIn);
    recordSignIn(signedIn);
  };

  const register = async (username: string, password: string, displayName?: string, inviteCode?: string) => {
    const u = await api.register(username, password, displayName, inviteCode);
    setUser(u);
    recordSignIn(u);
  };

  const logout = () => {
    api.logout();
    setUser(null);
  };

  const refreshUser = async () => {
    setUser(await api.me());
  };

  const resolveHomeServer = async (input: string): Promise<HomeServer> => {
    const parsed = parseServerInput(input);
    const resolved = await discoverHomeServer(parsed);
    // What the server says about itself is the truth: correct any remembered account that was saved with something else.
    refreshRememberedServer(resolved.origin, { domain: resolved.domain, serverName: resolved.serverName });

    const previous = getHomeServer();
    if (!previous || previous.domain !== resolved.domain) {
      // Switching to a genuinely different server - whatever session state
      // exists is meaningless against it.
      clearTokens();
      localStorage.removeItem(SYNC_CURSOR_KEY);
      setUser(null);
    }

    setHomeServerClient(resolved);
    setHomeServerState(resolved);
    return resolved;
  };

  const switchServer = () => {
    clearTokens();
    clearHomeServerClient();
    setUser(null);
    setHomeServerState(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        homeServer,
        isFixedServerMode: isFixedServerMode(),
        login,
        verifyTotpLogin,
        register,
        logout,
        refreshUser,
        resolveHomeServer,
        switchServer,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
