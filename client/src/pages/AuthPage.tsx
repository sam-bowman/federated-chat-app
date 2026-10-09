import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { ApiError } from "../api/client";
import { DiscoveryError, parseServerInput } from "../api/discovery";

function hostnameOf(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

export default function AuthPage({ mode }: { mode: "login" | "register" }) {
  const { login, register, homeServer, isFixedServerMode, resolveHomeServer, switchServer } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [serverInput, setServerInput] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  const isLogin = mode === "login";
  // Only in picker mode, before anything's been resolved - fixed-mode
  // deployments always have a homeServer (just the origin, until background
  // discovery fills in the rest), so this never shows for them.
  const showServerEntry = !isFixedServerMode && !homeServer;
  const displayDomain = homeServer ? homeServer.domain || hostnameOf(homeServer.origin) : "";
  const registrationBlocked = !isLogin && homeServer !== null && !homeServer.registrationEnabled;

  async function handleResolveServer(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);
    setResolving(true);
    try {
      const parsed = parseServerInput(serverInput);
      await resolveHomeServer(serverInput);
      if (parsed.username) setUsername(parsed.username);
    } catch (err) {
      setServerError(
        err instanceof DiscoveryError ? err.message : "Couldn't reach that server. Check the address and try again."
      );
    } finally {
      setResolving(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (isLogin) {
        await login(username, password);
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

  if (showServerEntry) {
    return (
      <div className="auth-page">
        <form className="auth-card" onSubmit={handleResolveServer}>
          <h1>Find your server</h1>
          <p className="hint">
            Enter your identity (<code>@you:chat.example.com</code>) or just the server's address.
          </p>
          <input
            placeholder="@you:chat.example.com"
            value={serverInput}
            onChange={(e) => setServerInput(e.target.value)}
            autoFocus
            required
          />
          {serverError && <div className="error-text">{serverError}</div>}
          <button className="btn" type="submit" disabled={resolving}>
            {resolving ? "Looking…" : "Continue"}
          </button>
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
          <code>@{username || "you"}:{displayDomain || "localhost"}</code>.
          {!isFixedServerMode && (
            <>
              {" "}
              <button type="button" className="link-button" onClick={switchServer}>
                Not you? Switch server.
              </button>
            </>
          )}
        </p>
        {registrationBlocked ? (
          <p className="hint">Registration is disabled on this server.</p>
        ) : (
          <>
            <input
              placeholder="username"
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase())}
              autoFocus
              required
            />
            {!isLogin && (
              <input
                placeholder="display name (optional)"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            )}
            <input
              placeholder="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={isLogin ? undefined : 8}
              required
            />
            {!isLogin && (
              <p className="hint">
                At least 8 characters, with an uppercase letter, a lowercase letter, a number, and a symbol.
              </p>
            )}
            {error && <div className="error-text">{error}</div>}
            <button className="btn" type="submit" disabled={submitting}>
              {isLogin ? "Sign in" : "Register"}
            </button>
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
    case "invalid_request": {
      const fieldErrors = body.details?.fieldErrors ?? {};
      const firstMessage = Object.values(fieldErrors).flat()[0];
      return firstMessage ?? "That request wasn't valid. Check your username and password and try again.";
    }
    default:
      return err.message;
  }
}
