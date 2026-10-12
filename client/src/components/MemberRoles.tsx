import { useState } from "react";
import * as api from "../api";
import { ApiError } from "../api/client";
import type { Community, CommunityMember } from "../api";

// Toggle chips for each non-default role - clicking one assigns or removes it.
// @everyone is left out: every member has it automatically.
export default function MemberRoles({
  community,
  member,
  onChanged,
}: {
  community: Community;
  member: CommunityMember;
  onChanged: () => Promise<void>;
}) {
  const [busyRoleId, setBusyRoleId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const assignable = community.roles.filter((r) => !r.isDefault);
  if (assignable.length === 0) return null;

  async function toggle(roleId: string, has: boolean) {
    setBusyRoleId(roleId);
    setError(null);
    try {
      await (has ? api.unassignRole(community.id, member.id, roleId) : api.assignRole(community.id, member.id, roleId));
      await onChanged();
    } catch (err) {
      const code = err instanceof ApiError ? (err.body as { error?: string } | null)?.error : undefined;
      setError(
        code === "role_exceeds_your_permissions"
          ? "You can only assign roles made up of permissions you hold yourself."
          : "Couldn't change that role."
      );
    } finally {
      setBusyRoleId(null);
    }
  }

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
      {assignable.map((role) => {
        const has = member.roleIds.includes(role.id);
        return (
          <button
            key={role.id}
            type="button"
            aria-pressed={has}
            title={has ? `Remove ${role.name}` : `Give ${role.name}`}
            className={has ? "btn" : "btn-secondary"}
            disabled={busyRoleId === role.id}
            style={{
              fontSize: 11,
              padding: "1px 8px",
              borderRadius: 10,
              borderLeft: role.color ? `4px solid ${role.color}` : undefined,
            }}
            onClick={() => void toggle(role.id, has)}
          >
            {role.name}
          </button>
        );
      })}
      {error && <div className="error-text" style={{ flexBasis: "100%" }}>{error}</div>}
    </div>
  );
}
