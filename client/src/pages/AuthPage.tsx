import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { ApiError } from "../api/client";

export default function AuthPage({ mode }: { mode: "login" | "register" }) {
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isLogin = mode === "login";

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

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={handleSubmit}>
        <h1>{isLogin ? "Welcome back" : "Create your identity"}</h1>
        <p className="hint">
          {isLogin ? "Sign in to " : "Register on "}
          <strong>this homeserver</strong>. Your identity will be <code>@{username || "you"}:localhost</code>.
        </p>
        <input
          placeholder="username"
          value={username}
          onChange={(e) => setUsername(e.target.value.toLowerCase())}
          autoFocus
          required
        />
        {!isLogin && (
          <input placeholder="display name (optional)" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        )}
        <input
          placeholder="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={isLogin ? undefined : 8}
          required
        />
        {!isLogin && <p className="hint">At least 8 characters.</p>}
        {error && <div className="error-text">{error}</div>}
        <button className="btn" type="submit" disabled={submitting}>
          {isLogin ? "Sign in" : "Register"}
        </button>
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
    case "invalid_request": {
      const fieldErrors = body.details?.fieldErrors ?? {};
      const firstMessage = Object.values(fieldErrors).flat()[0];
      return firstMessage ?? "That request wasn't valid. Check your username and password and try again.";
    }
    default:
      return err.message;
  }
}
