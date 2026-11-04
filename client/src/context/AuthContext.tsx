import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import * as api from "../api";
import type { PublicUser, TotpChallenge } from "../api";
import {
  ApiError,
  clearHomeServer as clearHomeServerClient,
  clearTokens,
  getHomeServer,
  isFixedServerMode,
  listAccountSessions,
  setHomeServer as setHomeServerClient,
  type HomeServer,
} from "../api/client";
import { discoverHomeServer, parseServerInput } from "../api/discovery";
import { PREFETCH_KEYS, clearBootPrefetch, takePrefetched } from "../lib/bootPrefetch";
import { SESSION_PREFIX, activateSession, claimLegacySession, getActiveId, removeSession } from "../lib/accountSessions";
import { goToApp } from "../lib/goToApp";
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
  /** Sets your own status from what the server just said it is, without asking for the whole person again. */
  applyPresence: (status: PublicUser["presence"]["status"], customStatus: string | null) => void;
  /** Parses + discovers `input`, clears any existing session only if it resolves to a different server. */
  resolveHomeServer: (input: string) => Promise<HomeServer>;
  /** Explicit "use a different server" action - forgets the remembered server, so the sign-in step asks again. Signs nobody out. No-op in fixed mode. */
  switchServer: () => void;
  /** Uses another account that is signed in on this device (#49): loads the app afresh as them. */
  switchAccount: (id: string) => void;
  /** Signs an account out of this device. The one in use is signed out like Sign out does; any other is simply forgotten. */
  signOutAccount: (id: string) => void;
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
    // Already asked for at the start of the page load, together with the lists, when there was a token to ask with (lib/bootPrefetch.ts).
    (takePrefetched<PublicUser>(PREFETCH_KEYS.me) ?? api.me())
      .then((signedIn) => {
        // Tokens carried over from before accounts were kept: now the server has said whose they are.
        claimLegacySession(signedIn);
        setUser(signedIn);
      })
      .catch((err) => {
        // Tokens the server will not take any more (signed out elsewhere, revoked, expired for good): this account is no longer signed in
        // on this device, and keeping it would offer it in the switcher only to fail. Not a server that could not be reached.
        if (err instanceof ApiError && err.status === 401) clearTokens();
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, []);

  // The account this tab uses can be signed out from another tab. What is on screen then belongs to nobody, and every request would go out
  // without a token: load again, which starts from whatever is still signed in.
  useEffect(() => {
    const own = getActiveId();
    if (!own) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key === SESSION_PREFIX + own && event.newValue === null) goToApp("/");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [user?.id]);

  const login = async (username: string, password: string) => {
    clearBootPrefetch(); // anything asked for at the start was for whoever was signed in then
    const result = await api.login(username, password);
    if ("totpRequired" in result) {
      return result;
    }
    setUser(result);
    recordSignIn(result);
  };

  const verifyTotpLogin = async (challengeToken: string, input: { code?: string; recoveryCode?: string }) => {
    clearBootPrefetch();
    const signedIn = await api.verifyTotpLogin(challengeToken, input);
    setUser(signedIn);
    recordSignIn(signedIn);
  };

  const register = async (username: string, password: string, displayName?: string, inviteCode?: string) => {
    clearBootPrefetch();
    const u = await api.register(username, password, displayName, inviteCode);
    setUser(u);
    recordSignIn(u);
  };

  const logout = () => {
    clearBootPrefetch();
    api.logout();
    // Another account is still signed in on this device: carry on as them, as a person who has several would expect.
    const next = listAccountSessions()[0];
    if (next) {
      activateSession(next.id);
      goToApp("/");
      return;
    }
    setUser(null);
  };

  const switchAccount = (id: string) => {
    clearBootPrefetch();
    activateSession(id);
    goToApp("/");
  };

  const signOutAccount = (id: string) => {
    if (id === getActiveId()) {
      logout();
      return;
    }
    removeSession(id);
  };

  const refreshUser = async () => {
    setUser(await api.me());
  };

  const applyPresence: AuthContextValue["applyPresence"] = (status, customStatus) =>
    setUser((current) => (current ? { ...current, presence: { ...current.presence, status, customStatus } } : current));

  const resolveHomeServer = async (input: string): Promise<HomeServer> => {
    const parsed = parseServerInput(input);
    const resolved = await discoverHomeServer(parsed);
    // What the server says about itself is the truth: correct any remembered account that was saved with something else.
    refreshRememberedServer(resolved.origin, { domain: resolved.domain, serverName: resolved.serverName });

    // Whatever was asked for at the start was for the server before: the accounts signed in on this device are untouched (they
    // are only ever used with the server that issued them), so this is also how a second account on another server is added.
    clearBootPrefetch();
    setHomeServerClient(resolved);
    setHomeServerState(resolved);
    return resolved;
  };

  const switchServer = () => {
    clearBootPrefetch();
    clearHomeServerClient();
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
        applyPresence,
        resolveHomeServer,
        switchServer,
        switchAccount,
        signOutAccount,
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
