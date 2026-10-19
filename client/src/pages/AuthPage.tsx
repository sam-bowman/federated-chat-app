import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { ApiError } from "../api/client";
import { DiscoveryError, parseServerInput } from "../api/discovery";
import {
  forgetAccount,
  getRecentAccounts,
  isRememberEnabled,
  setRememberEnabled,
  usernamesForServer,
  type RecentAccount,
} from "../lib/recentAccounts";
import Button from "../components/Button";

/** What to put in the server box for a remembered origin: https hosts read better without the scheme. */
function serverInputFor(origin: string): string {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" ? url.host : url.origin;
  } catch {
    return origin;
  }
}

function lastUsedLabel(timestamp: number): string {
  const days = Math.floor((Date.now() - timestamp) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

export default function AuthPage({ mode }: { mode: "login" | "register" }) {
  const { login, verifyTotpLogin, register, homeServer, isFixedServerMode, resolveHomeServer, switchServer } =
    useAuth();
  const navigate = useNavigate();
  const [recent, setRecent] = useState<RecentAccount[]>(() => getRecentAccounts());
  const [remember, setRemember] = useState(() => isRememberEnabled());
  // Reopening the client on a server we already know: preselect the last username used there.
  const [username, setUsername] = useState(() =>
    homeServer ? (usernamesForServer(getRecentAccounts(), homeServer.origin)[0] ?? "") : ""
  );
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Set once login() comes back asking for a second factor - while this is
  // non-null, the form below shows the 2FA step instead of username/password.
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [totpInput, setTotpInput] = useState("");
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);

  const [serverInput, setServerInput] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  const isLogin = mode === "login";
  // Only in picker mode, before anything's been resolved - fixed-mode
  // deployments always have a homeServer (just the origin, until background
  // discovery fills in the rest), so this never shows for them.
  const showServerEntry = !isFixedServerMode && !homeServer;
  // The domain the SERVER reported. Until discovery has answered there is none, and it is never guessed from the address
  // the API is reached at: that can be another host (api.example.com) from the one in people's ids (example.com), and a
  // wrong address in "Your identity will be ..." gets copied and given to people.
  const displayDomain = homeServer?.domain ?? "";
  const registrationBlocked = !isLogin && homeServer !== null && !homeServer.registrationEnabled;

  // `knownUsername` comes from a remembered account the user clicked; either way the
  // server is re-resolved through discovery rather than trusting what was stored.
  async function resolveServer(input: string, knownUsername?: string) {
    setServerError(null);
    setResolving(true);
    try {
      const parsed = parseServerInput(input);
      const resolved = await resolveHomeServer(input);
      const known = knownUsername ?? parsed.username ?? usernamesForServer(recent, resolved.origin)[0];
      if (known) setUsername(known);
    } catch (err) {
      setServerError(
        err instanceof DiscoveryError ? err.message : "Couldn't reach that server. Check the address and try again."
      );
    } finally {
      setResolving(false);
    }
  }

  function handleResolveServer(e: React.FormEvent) {
    e.preventDefault();
    return resolveServer(serverInput);
  }

  function handleForget(account: RecentAccount) {
    forgetAccount(account);
    setRecent(getRecentAccounts());
  }

  function handleRememberChange(checked: boolean) {
    setRemember(checked);
    setRememberEnabled(checked);
  }

  const usernameSuggestions = homeServer ? usernamesForServer(recent, homeServer.origin) : [];
  const serverSuggestions = [...new Set(recent.map((a) => serverInputFor(a.origin)))];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (isLogin) {
        const result = await login(username, password);
        if (result && "totpRequired" in result) {
          setChallengeToken(result.challengeToken);
          return;
        }
      } else {
        await register(username, password, displayName || undefined);
      }
      navigate("/friends");
    } catch (err) {
      if (err instanceof ApiError) {
        setError(friendlyError(err));
      } else {
        setError("Something went wrong. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleTotpSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await verifyTotpLogin(challengeToken!, useRecoveryCode ? { recoveryCode: totpInput } : { code: totpInput });
      navigate("/friends");
    } catch (err) {
      if (err instanceof ApiError) {
        setError(friendlyError(err));
      } else {
        setError("Something went wrong. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (showServerEntry) {
    return (
      <div className="auth-page">
        <form className="auth-card" onSubmit={handleResolveServer}>
          <h1>{recent.length > 0 ? "Welcome back" : "Find your server"}</h1>
          {recent.length > 0 && (
            <ul className="recent-accounts" aria-label="Recent accounts">
              {recent.map((account) => (
                <li key={`${account.origin}|${account.username}`} className="recent-account">
                  <button
                    type="button"
                    className="recent-account-pick"
                    disabled={resolving}
                    onClick={() => resolveServer(account.origin, account.username)}
                  >
                    <span className="recent-account-identity">
                      @{account.username}:{account.domain}
                    </span>
                    <span className="recent-account-meta">
                      {account.serverName ? `${account.serverName} · ` : ""}last used {lastUsedLabel(account.lastUsedAt)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="recent-account-forget"
                    aria-label={`Forget @${account.username}:${account.domain}`}
                    title="Forget this account"
                    onClick={() => handleForget(account)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="hint">
            {recent.length > 0 ? "Or use a different server or account. " : ""}
            Enter your identity (<code>@you:chat.example.com</code>) or just the server's address.
          </p>
          <input
            name="server"
            list={serverSuggestions.length > 0 ? "recent-servers" : undefined}
            autoComplete="url"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="@you:chat.example.com"
            value={serverInput}
            onChange={(e) => setServerInput(e.target.value)}
            autoFocus
            required
          />
          {serverSuggestions.length > 0 && (
            <datalist id="recent-servers">
              {serverSuggestions.map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
          )}
          {serverError && <div className="error-text">{serverError}</div>}
          <Button type="submit" disabled={resolving}>
            {resolving ? "Looking…" : "Continue"}
          </Button>
        </form>
      </div>
    );
  }

  if (challengeToken) {
    return (
      <div className="auth-page">
        <form className="auth-card" onSubmit={handleTotpSubmit}>
          <h1>Two-factor authentication</h1>
          <p className="hint">
            {useRecoveryCode
              ? "Enter one of your recovery codes."
              : "Enter the 6-digit code from your authenticator app."}
          </p>
          <input
            name="otp"
            autoComplete="one-time-code"
            placeholder={useRecoveryCode ? "recovery code" : "123456"}
            value={totpInput}
            onChange={(e) => setTotpInput(e.target.value)}
            autoFocus
            required
          />
          {error && <div className="error-text">{error}</div>}
          <Button type="submit" disabled={submitting}>
            Verify
          </Button>
          <p className="hint">
            <Button
              type="button"
              onClick={() => {
                setUseRecoveryCode((v) => !v);
                setTotpInput("");
                setError(null);
              }}
              variant="link"
            >
              {useRecoveryCode ? "Use an authenticator code instead" : "Use a recovery code instead"}
            </Button>
          </p>
          <p className="hint">
            <Button
              type="button"
              onClick={() => {
                setChallengeToken(null);
                setTotpInput("");
                setError(null);
              }}
              variant="link"
            >
              Back to sign in
            </Button>
          </p>
        </form>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={handleSubmit}>
        <h1>{isLogin ? "Welcome back" : "Create your identity"}</h1>
        <p className="hint">
          {isLogin ? "Sign in to " : "Register on "}
          <strong>{displayDomain || "this homeserver"}</strong>. Your identity will be{" "}
          <code>@{username || "you"}:{displayDomain || "…"}</code>.
          {!isFixedServerMode && (
            <>
              {" "}
              <Button type="button" onClick={switchServer} variant="link">
                Not you? Switch server.
              </Button>
            </>
          )}
        </p>
        {registrationBlocked ? (
          <p className="hint">Registration is disabled on this server.</p>
        ) : (
          <>
            <input
              name="username"
              list={usernameSuggestions.length > 0 ? "recent-usernames" : undefined}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="username"
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase())}
              autoFocus
              required
            />
            {!isLogin && (
              <input
                name="displayName"
                autoComplete="nickname"
                placeholder="display name (optional)"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            )}
            <input
              name="password"
              autoComplete={isLogin ? "current-password" : "new-password"}
              placeholder="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={isLogin ? undefined : 8}
              required
            />
            {usernameSuggestions.length > 0 && (
              <datalist id="recent-usernames">
                {usernameSuggestions.map((value) => (
                  <option key={value} value={value} />
                ))}
              </datalist>
            )}
            <label className="remember-option">
              <input type="checkbox" checked={remember} onChange={(e) => handleRememberChange(e.target.checked)} />
              Remember this server and username on this device
            </label>
            {!isLogin && (
              <p className="hint">
                At least 8 characters, with an uppercase letter, a lowercase letter, a number, and a symbol.
              </p>
            )}
            {error && <div className="error-text">{error}</div>}
            <Button type="submit" disabled={submitting}>
              {isLogin ? "Sign in" : "Register"}
            </Button>
          </>
        )}
        <p className="hint">
          {isLogin ? (
            <>
              No account? <Link to="/register">Register</Link>
            </>
          ) : (
            <>
              Already have one? <Link to="/login">Sign in</Link>
            </>
          )}
        </p>
      </form>
    </div>
  );
}

interface ZodFlatten {
  fieldErrors?: Record<string, string[]>;
}

function friendlyError(err: ApiError): string {
  const body = err.body as { error?: string; details?: ZodFlatten } | null;
  switch (body?.error) {
    case "username_taken":
      return "That username is already taken.";
    case "invalid_credentials":
      return "Incorrect username or password.";
    case "registration_disabled":
      return "Registration is disabled on this server.";
    case "password_breached":
      return "That password has appeared in a known data breach. Please choose a different one.";
    case "invalid_code":
      return "That code didn't work. Check your authenticator app (or recovery code) and try again.";
    case "invalid_challenge_token":
      return "That login attempt expired. Please sign in again.";
    case "invalid_request": {
      const fieldErrors = body.details?.fieldErrors ?? {};
      const firstMessage = Object.values(fieldErrors).flat()[0];
      return firstMessage ?? "That request wasn't valid. Check your username and password and try again.";
    }
    default:
      return err.message;
  }
}
