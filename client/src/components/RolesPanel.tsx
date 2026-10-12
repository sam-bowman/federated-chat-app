import { useState } from "react";
import * as api from "../api";
import { ApiError } from "../api/client";
import type { Community, Role } from "../api";
import { ROLE_PERMISSIONS, describePermissions, hasPermissionBit, withPermissionBit } from "../lib/permissions";
import ConfirmModal from "./ConfirmModal";

interface Draft {
  id: string | null; // null while creating
  name: string;
  color: string | null;
  permissions: string;
  isDefault: boolean;
}

const NEW_ROLE: Draft = { id: null, name: "", color: null, permissions: "0", isDefault: false };
const FALLBACK_COLOR = "#99aab5";

function errorMessage(err: unknown): string {
  const code = err instanceof ApiError ? (err.body as { error?: string } | null)?.error : undefined;
  if (code === "role_exceeds_your_permissions") return "You can only manage roles made up of permissions you hold yourself.";
  if (code === "cannot_rename_default_role") return "The default role can't be renamed.";
  if (code === "cannot_delete_default_role") return "The default role can't be deleted.";
  if (code === "forbidden") return "You don't have permission to manage roles.";
  return "Something went wrong. Try again.";
}

export default function RolesPanel({ community, onChanged }: { community: Community; onChanged: () => Promise<void> }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<Role | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // @everyone first, then in the order they were made.
  const roles = [...community.roles].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.position - b.position);
  const memberCount = (role: Role) => community.members.filter((m) => m.roleIds.includes(role.id)).length;

  async function run(action: () => Promise<unknown>, onDone?: () => void) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await onChanged();
      onDone?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    const color = draft.color ?? undefined;
    void run(
      () =>
        draft.id === null
          ? api.createRole(community.id, { name: draft.name.trim(), color, permissions: draft.permissions })
          : api.updateRole(community.id, draft.id, {
              // The default role's name is fixed, so don't send it.
              ...(draft.isDefault ? {} : { name: draft.name.trim() }),
              color: draft.color,
              permissions: draft.permissions,
            }),
      () => setDraft(null)
    );
  }

  if (draft) {
    return (
      <form onSubmit={handleSave} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <label className="hint">Name</label>
        <input
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          disabled={draft.isDefault}
          maxLength={50}
          autoFocus
          required
        />

        <label className="hint">Colour</label>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <input
            type="color"
            aria-label="Role colour"
            value={draft.color ?? FALLBACK_COLOR}
            onChange={(e) => setDraft({ ...draft, color: e.target.value })}
            disabled={draft.color === null}
          />
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={draft.color !== null}
              onChange={(e) => setDraft({ ...draft, color: e.target.checked ? FALLBACK_COLOR : null })}
            />
            <span className="hint">Give this role a colour</span>
          </label>
        </div>

        <label className="hint">Permissions</label>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {ROLE_PERMISSIONS.map((p) => (
            <label key={p.key} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <input
                type="checkbox"
                checked={hasPermissionBit(draft.permissions, p.bit)}
                onChange={(e) => setDraft({ ...draft, permissions: withPermissionBit(draft.permissions, p.bit, e.target.checked) })}
              />
              <span>
                {p.label}
                <span className="hint" style={{ display: "block" }}>
                  {p.description}
                </span>
              </span>
            </label>
          ))}
        </div>

        {error && <div className="error-text">{error}</div>}
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" type="submit" disabled={busy || !draft.name.trim()}>
            {draft.id === null ? "Create role" : "Save role"}
          </button>
          <button
            type="button"
            className="btn-secondary"
            style={{ borderRadius: 6 }}
            onClick={() => {
              setDraft(null);
              setError(null);
            }}
          >
            Cancel
          </button>
        </div>
      </form>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <button
        className="btn"
        style={{ alignSelf: "flex-start", marginBottom: 4 }}
        onClick={() => {
          setError(null);
          setDraft(NEW_ROLE);
        }}
      >
        New role
      </button>
      {error && <div className="error-text">{error}</div>}
      <div style={{ maxHeight: 340, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
        {roles.map((role) => (
          <div key={role.id} className="friend-request-row" style={{ marginBottom: 0 }}>
            <span
              aria-hidden
              style={{ width: 12, height: 12, borderRadius: "50%", background: role.color ?? "var(--text-dim)", flexShrink: 0 }}
            />
            <div className="grow">
              <div>
                {role.name}
                {role.isDefault && <span className="hint"> · everyone</span>}
              </div>
              <div className="hint">
                {describePermissions(role.permissions)} · {memberCount(role)} {memberCount(role) === 1 ? "member" : "members"}
              </div>
            </div>
            <button
              className="btn-secondary"
              style={{ fontSize: 11, padding: "2px 6px", borderRadius: 4 }}
              onClick={() => {
                setError(null);
                setDraft({ id: role.id, name: role.name, color: role.color, permissions: role.permissions, isDefault: role.isDefault });
              }}
            >
              Edit
            </button>
            {!role.isDefault && (
              <button
                className="btn-danger"
                style={{ fontSize: 11, padding: "2px 6px", borderRadius: 4 }}
                onClick={() => setDeleting(role)}
              >
                Delete
              </button>
            )}
          </div>
        ))}
      </div>

      {deleting && (
        <ConfirmModal
          title="Delete role"
          message={`Delete "${deleting.name}"? ${memberCount(deleting)} ${
            memberCount(deleting) === 1 ? "member loses" : "members lose"
          } it, along with anything it allowed them to do.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => void run(() => api.deleteRole(community.id, deleting.id))}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
