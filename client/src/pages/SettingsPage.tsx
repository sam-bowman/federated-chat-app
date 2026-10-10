import { useState } from "react";
import qrcode from "qrcode-generator";
import * as api from "../api";
import { ApiError } from "../api/client";
import { useAuth } from "../context/AuthContext";
import Avatar from "../components/Avatar";

const STATUSES = ["ONLINE", "AWAY", "BUSY", "DO_NOT_DISTURB", "INVISIBLE"] as const;

function totpErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const code = (err.body as { error?: string } | null)?.error;
    if (code === "invalid_credentials") return "Incorrect password.";
    if (code === "invalid_code") return "That code didn't work. Check your authenticator app and try again.";
    if (code === "totp_already_enabled") return "Two-factor authentication is already enabled.";
  }
  return "Something went wrong. Please try again.";
}

// Rendered client-side, never sent to a third party - the otpauth:// URI
// carries the TOTP secret itself.
function qrSvg(otpauthUrl: string): string {
  const qr = qrcode(0, "M");
  qr.addData(otpauthUrl);
  qr.make();
  return qr.createSvgTag(4, 4);
}

type TotpStep = "idle" | "password" | "scan" | "recoveryCodes" | "disablePassword";

export default function SettingsPage() {
  const { user, refreshUser } = useAuth();
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [bio, setBio] = useState(user?.bio ?? "");
  const [customStatus, setCustomStatus] = useState(user?.presence.customStatus ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [totpStep, setTotpStep] = useState<TotpStep>("idle");
  const [totpPassword, setTotpPassword] = useState("");
  const [totpSecret, setTotpSecret] = useState("");
  const [totpOtpauthUrl, setTotpOtpauthUrl] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [totpError, setTotpError] = useState<string | null>(null);
  const [totpBusy, setTotpBusy] = useState(false);

  if (!user) return null;

  function resetTotpFlow() {
    setTotpStep("idle");
    setTotpPassword("");
    setTotpSecret("");
    setTotpOtpauthUrl("");
    setTotpCode("");
    setTotpError(null);
  }

  async function handleTotpSetupPassword(e: React.FormEvent) {
    e.preventDefault();
    setTotpError(null);
    setTotpBusy(true);
    try {
      const { secret, otpauthUrl } = await api.setupTotp(totpPassword);
      setTotpSecret(secret);
      setTotpOtpauthUrl(otpauthUrl);
      setTotpStep("scan");
    } catch (err) {
      setTotpError(totpErrorMessage(err));
    } finally {
      setTotpBusy(false);
    }
  }

  async function handleTotpConfirmCode(e: React.FormEvent) {
    e.preventDefault();
    setTotpError(null);
    setTotpBusy(true);
    try {
      const { recoveryCodes: codes } = await api.confirmTotpSetup(totpCode);
      setRecoveryCodes(codes);
      setTotpStep("recoveryCodes");
      await refreshUser();
    } catch (err) {
      setTotpError(totpErrorMessage(err));
    } finally {
      setTotpBusy(false);
    }
  }

  async function handleTotpDisable(e: React.FormEvent) {
    e.preventDefault();
    setTotpError(null);
    setTotpBusy(true);
    try {
      await api.disableTotp(totpPassword);
      await refreshUser();
      resetTotpFlow();
    } catch (err) {
      setTotpError(totpErrorMessage(err));
    } finally {
      setTotpBusy(false);
    }
  }

  async function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const uploaded = await api.uploadFile(file);
    await api.updateMe({ avatarUrl: uploaded.url });
    await refreshUser();
  }

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.updateMe({ displayName, bio: bio || null });
      await refreshUser();
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } finally {
      setSaving(false);
    }
  }

  async function handleStatusChange(status: string) {
    await api.setPresence({ status });
    await refreshUser();
  }

  async function handleCustomStatusSave() {
    await api.setPresence({ customStatus: customStatus || null });
    await refreshUser();
  }

  return (
    <>
      <div className="main-header">Settings</div>
      <div className="panel" style={{ maxWidth: 480 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 20 }}>
          <Avatar user={user} />
          <label className="btn-secondary" style={{ borderRadius: 6, padding: "6px 12px" }}>
            Change avatar
            <input type="file" accept="image/*" style={{ display: "none" }} onChange={handleAvatarChange} />
          </label>
        </div>

        <h3>Identity</h3>
        <p className="hint">{user.identity} (cannot be changed)</p>

        <form onSubmit={handleSaveProfile} style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 24 }}>
          <label className="hint">Display name</label>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          <label className="hint">Bio</label>
          <textarea value={bio} onChange={(e) => setBio(e.target.value)} rows={3} />
          <button className="btn" type="submit" disabled={saving} style={{ alignSelf: "flex-start" }}>
            {saved ? "Saved!" : "Save profile"}
          </button>
        </form>

        <h3>Presence</h3>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          {STATUSES.map((s) => (
            <button
              key={s}
              className={user.presence.status === s ? "btn" : "btn-secondary"}
              style={{ borderRadius: 6, fontSize: 12 }}
              onClick={() => handleStatusChange(s)}
            >
              {s.replace(/_/g, " ")}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            placeholder="Custom status message…"
            value={customStatus}
            onChange={(e) => setCustomStatus(e.target.value)}
            style={{ flex: 1 }}
          />
          <button className="btn-secondary" style={{ borderRadius: 6 }} onClick={handleCustomStatusSave}>
            Set
          </button>
        </div>

        <h3>Two-factor authentication</h3>
        {totpStep === "idle" && (
          <>
            <p className="hint">
              {user.totpEnabled
                ? "Enabled. You'll need a code from your authenticator app to sign in."
                : "Not enabled. Add an authenticator app for an extra layer of login security."}
            </p>
            <button
              className="btn-secondary"
              style={{ borderRadius: 6 }}
              onClick={() => setTotpStep(user.totpEnabled ? "disablePassword" : "password")}
            >
              {user.totpEnabled ? "Disable" : "Set up two-factor authentication"}
            </button>
          </>
        )}

        {totpStep === "password" && (
          <form onSubmit={handleTotpSetupPassword} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <label className="hint">Confirm your password to continue</label>
            <input
              type="password"
              value={totpPassword}
              onChange={(e) => setTotpPassword(e.target.value)}
              autoFocus
              required
            />
            {totpError && <div className="error-text">{totpError}</div>}
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn" type="submit" disabled={totpBusy} style={{ alignSelf: "flex-start" }}>
                Continue
              </button>
              <button type="button" className="btn-secondary" style={{ borderRadius: 6 }} onClick={resetTotpFlow}>
                Cancel
              </button>
            </div>
          </form>
        )}

        {totpStep === "scan" && (
          <form onSubmit={handleTotpConfirmCode} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p className="hint">Scan this with your authenticator app, or enter the code manually.</p>
            <div style={{ width: 160 }} dangerouslySetInnerHTML={{ __html: qrSvg(totpOtpauthUrl) }} />
            <p className="hint" style={{ fontFamily: "monospace", wordBreak: "break-all" }}>
              {totpSecret}
            </p>
            <label className="hint">Enter the 6-digit code it shows</label>
            <input value={totpCode} onChange={(e) => setTotpCode(e.target.value)} autoFocus required />
            {totpError && <div className="error-text">{totpError}</div>}
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn" type="submit" disabled={totpBusy} style={{ alignSelf: "flex-start" }}>
                Confirm
              </button>
              <button type="button" className="btn-secondary" style={{ borderRadius: 6 }} onClick={resetTotpFlow}>
                Cancel
              </button>
            </div>
          </form>
        )}

        {totpStep === "recoveryCodes" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p className="hint">
              Two-factor authentication is enabled. Save these recovery codes somewhere safe - each can be used once
              to sign in if you lose access to your authenticator app. They won't be shown again.
            </p>
            <pre style={{ fontFamily: "monospace", lineHeight: 1.6 }}>{recoveryCodes.join("\n")}</pre>
            <button
              className="btn"
              style={{ alignSelf: "flex-start" }}
              onClick={() => {
                setRecoveryCodes([]);
                resetTotpFlow();
              }}
            >
              I've saved these
            </button>
          </div>
        )}

        {totpStep === "disablePassword" && (
          <form onSubmit={handleTotpDisable} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <label className="hint">Confirm your password to disable two-factor authentication</label>
            <input
              type="password"
              value={totpPassword}
              onChange={(e) => setTotpPassword(e.target.value)}
              autoFocus
              required
            />
            {totpError && <div className="error-text">{totpError}</div>}
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn" type="submit" disabled={totpBusy} style={{ alignSelf: "flex-start" }}>
                Disable
              </button>
              <button type="button" className="btn-secondary" style={{ borderRadius: 6 }} onClick={resetTotpFlow}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </>
  );
}
