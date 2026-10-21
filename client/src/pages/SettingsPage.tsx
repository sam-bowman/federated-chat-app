import { useState } from "react";
import qrcode from "qrcode-generator";
import * as api from "../api";
import { ApiError } from "../api/client";
import { useAuth } from "../context/AuthContext";
import Avatar from "../components/Avatar";
import AboutSection from "../components/AboutSection";
import UpdatesSection from "../components/UpdatesSection";
import NotificationsSection from "../components/NotificationsSection";
import VoiceSettingsSection from "../components/VoiceSettingsSection";
import LinkPreviewsSection from "../components/LinkPreviewsSection";
import AppearanceSection from "../components/AppearanceSection";
import PrivacySection from "../components/PrivacySection";
import DataExportSection from "../components/DataExportSection";
import RememberedAccountsSection from "../components/RememberedAccountsSection";
import { noAutofill, passwordManagerIgnore } from "../lib/noAutofill";
import Button from "../components/Button";
import CustomStatusForm from "../components/CustomStatusForm";
import ColourField from "../components/ColourField";
import FileButton from "../components/FileButton";
import ProfileCard from "../components/ProfileCard";
import { BIO_MAX, PRONOUNS_MAX } from "../lib/profile";
import { PRESENCE_OPTIONS } from "../lib/presence";

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
  const [pronouns, setPronouns] = useState(user?.pronouns ?? "");
  const [accentColor, setAccentColor] = useState<string | null>(user?.accentColor ?? null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);

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

  async function handleAvatarChange(file: File | null) {
    if (!file) return;
    // The upload route also takes documents and video; only a picture is an avatar.
    if (!file.type.startsWith("image/")) {
      setAvatarError("That isn't a picture. Choose a PNG, JPEG, GIF or WebP image.");
      return;
    }
    setAvatarBusy(true);
    setAvatarError(null);
    try {
      const uploaded = await api.uploadFile(file);
      await api.updateMe({ avatarUrl: uploaded.url });
      await refreshUser();
    } catch {
      setAvatarError("Couldn't use that picture. It may be too large; try a smaller one.");
    } finally {
      setAvatarBusy(false);
    }
  }

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setProfileError(null);
    try {
      await api.updateMe({ displayName, bio: bio || null, pronouns: pronouns.trim() || null, accentColor });
      await refreshUser();
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch {
      setProfileError("Couldn't save your profile. Check the fields and try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleStatusChange(status: string) {
    await api.setPresence({ status });
    await refreshUser();
  }

  return (
    <>
      <div className="main-header">Settings</div>
      <div className="panel" style={{ maxWidth: "53.75rem" }}>
        <h3>Profile</h3>
        <div className="settings-profile">
          <div className="settings-profile-edit">
            <div className="settings-avatar">
              <Avatar user={user} size="xl" />
              <div className="settings-avatar-actions">
                <FileButton
                  file={null}
                  onChange={(file) => void handleAvatarChange(file)}
                  accept="image/*"
                  label={avatarBusy ? "Uploading…" : "Change avatar"}
                  showName={false}
                  disabled={avatarBusy}
                />
                <div className="hint">A square picture works best; it is shown as a circle.</div>
                {avatarError && (
                  <div className="error-text" role="alert">
                    {avatarError}
                  </div>
                )}
              </div>
            </div>

            <p className="hint">{user.identity} (cannot be changed)</p>

            <form onSubmit={handleSaveProfile} style={{ display: "flex", flexDirection: "column", gap: "0.625rem", marginBottom: "1.5rem" }}>
              <label className="hint">Display name</label>
              {/* A person's own name: keep its autocomplete token (WCAG 1.3.5) but tell password managers to stay out. */}
              <input {...passwordManagerIgnore} autoComplete="nickname" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              <label className="hint" htmlFor="profile-pronouns">
                Pronouns (optional)
              </label>
              <input
                {...noAutofill}
                id="profile-pronouns"
                value={pronouns}
                onChange={(e) => setPronouns(e.target.value)}
                maxLength={PRONOUNS_MAX}
                placeholder="for example they/them"
              />
              <label className="hint" htmlFor="profile-bio">
                Bio
              </label>
              <textarea {...noAutofill} id="profile-bio" value={bio} onChange={(e) => setBio(e.target.value)} rows={3} maxLength={BIO_MAX} />
              <div className="hint">Profile colour</div>
              <div>
                <ColourField
                  label="Profile colour"
                  value={accentColor}
                  onChange={setAccentColor}
                  previewText={displayName || user.displayName}
                  noneLabel="Default colour"
                />
              </div>
              {profileError && (
                <div className="error-text" role="alert">
                  {profileError}
                </div>
              )}
              <Button type="submit" disabled={saving} style={{ alignSelf: "flex-start" }}>
                {saved ? "Saved!" : "Save profile"}
              </Button>
            </form>
          </div>

          <div className="settings-profile-preview">
            <div className="hint">This is how others see your profile</div>
            <ProfileCard
              user={{
                ...user,
                displayName: displayName.trim() || user.displayName,
                bio: bio.trim() || null,
                pronouns: pronouns.trim() || null,
                accentColor,
              }}
            />
          </div>
        </div>

        <div className="settings-narrow">
        <AppearanceSection />

        <h3>Presence</h3>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.625rem" }}>
          {PRESENCE_OPTIONS.map((option) => (
            <Button
              key={option.value}
              variant={user.presence.status === option.value ? "primary" : "secondary"}
              size="sm"
              aria-pressed={user.presence.status === option.value}
              title={option.description}
              onClick={() => handleStatusChange(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
        {/* Keyed by the saved value, so a change made from the footer shows here instead of leaving a stale copy. */}
        <CustomStatusForm
          key={user.presence.customStatus ?? ""}
          current={user.presence.customStatus}
          onSave={async (next) => {
            await api.setPresence({ customStatus: next });
            await refreshUser();
          }}
        />

        <PrivacySection />

        <DataExportSection />

        <h3>Two-factor authentication</h3>
        {totpStep === "idle" && (
          <>
            <p className="hint">
              {user.totpEnabled
                ? "Enabled. You'll need a code from your authenticator app to sign in."
                : "Not enabled. Add an authenticator app for an extra layer of login security."}
            </p>
            <Button
              onClick={() => setTotpStep(user.totpEnabled ? "disablePassword" : "password")}
              variant="secondary"
            >
              {user.totpEnabled ? "Disable" : "Set up two-factor authentication"}
            </Button>
          </>
        )}

        {totpStep === "password" && (
          <form onSubmit={handleTotpSetupPassword} style={{ display: "flex", flexDirection: "column", gap: "0.625rem" }}>
            <label className="hint">Confirm your password to continue</label>
            <input
              type="password"
              autoComplete="current-password"
              value={totpPassword}
              onChange={(e) => setTotpPassword(e.target.value)}
              autoFocus
              required
            />
            {totpError && <div className="error-text">{totpError}</div>}
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <Button type="submit" disabled={totpBusy} style={{ alignSelf: "flex-start" }}>
                Continue
              </Button>
              <Button type="button" onClick={resetTotpFlow} variant="secondary">
                Cancel
              </Button>
            </div>
          </form>
        )}

        {totpStep === "scan" && (
          <form onSubmit={handleTotpConfirmCode} style={{ display: "flex", flexDirection: "column", gap: "0.625rem" }}>
            <p className="hint">Scan this with your authenticator app, or enter the code manually.</p>
            <div className="qr-code" dangerouslySetInnerHTML={{ __html: qrSvg(totpOtpauthUrl) }} />
            <p className="hint" style={{ fontFamily: "monospace", wordBreak: "break-all" }}>
              {totpSecret}
            </p>
            <label className="hint">Enter the 6-digit code it shows</label>
            <input autoComplete="one-time-code" value={totpCode} onChange={(e) => setTotpCode(e.target.value)} autoFocus required />
            {totpError && <div className="error-text">{totpError}</div>}
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <Button type="submit" disabled={totpBusy} style={{ alignSelf: "flex-start" }}>
                Confirm
              </Button>
              <Button type="button" onClick={resetTotpFlow} variant="secondary">
                Cancel
              </Button>
            </div>
          </form>
        )}

        {totpStep === "recoveryCodes" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.625rem" }}>
            <p className="hint">
              Two-factor authentication is enabled. Save these recovery codes somewhere safe - each can be used once
              to sign in if you lose access to your authenticator app. They won't be shown again.
            </p>
            <pre style={{ fontFamily: "monospace", lineHeight: 1.6 }}>{recoveryCodes.join("\n")}</pre>
            <Button
              onClick={() => {
                setRecoveryCodes([]);
                resetTotpFlow();
              }}
              style={{ alignSelf: "flex-start" }}
            >
              I've saved these
            </Button>
          </div>
        )}

        {totpStep === "disablePassword" && (
          <form onSubmit={handleTotpDisable} style={{ display: "flex", flexDirection: "column", gap: "0.625rem" }}>
            <label className="hint">Confirm your password to disable two-factor authentication</label>
            <input
              type="password"
              autoComplete="current-password"
              value={totpPassword}
              onChange={(e) => setTotpPassword(e.target.value)}
              autoFocus
              required
            />
            {totpError && <div className="error-text">{totpError}</div>}
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <Button type="submit" disabled={totpBusy} style={{ alignSelf: "flex-start" }}>
                Disable
              </Button>
              <Button type="button" onClick={resetTotpFlow} variant="secondary">
                Cancel
              </Button>
            </div>
          </form>
        )}

        <RememberedAccountsSection />

        <NotificationsSection />

        <VoiceSettingsSection />

        <LinkPreviewsSection />

        <UpdatesSection />

        <AboutSection />
        </div>
      </div>
    </>
  );
}
