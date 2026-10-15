import { useState } from "react";
import * as api from "../api";
import { ApiError } from "../api/client";
import type { Community, CommunityMember } from "../api";
import { ALL_PERMISSION_BITS, permissionsWithin } from "../lib/permissions";
import Button from "./Button";

// Toggle chips for each non-default role - clicking one assigns or removes it.
// @everyone is left out: every member has it automatically.
export default function MemberRoles({
  community,
  member,
  onChanged,
  viewerPermissions = ALL_PERMISSION_BITS,
}: {
  community: Community;
  member: CommunityMember;
  onChanged: () => Promise<void>;
  /** A role made of permissions the viewer doesn't hold can't be given or taken away (the server refuses), so it is disabled. */
  viewerPermissions?: bigint;
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
    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem", marginTop: "0.25rem" }}>
      {assignable.map((role) => {
        const has = member.roleIds.includes(role.id);
        const withinReach = permissionsWithin(viewerPermissions, role.permissions);
        return (
          <Button
            key={role.id}
            variant={has ? "primary" : "secondary"}
            size="sm"
            className={role.color ? "role-chip role-chip-colored" : "role-chip"}
            style={role.color ? ({ "--role-color": role.color } as React.CSSProperties) : undefined}
            aria-pressed={has}
            title={
              !withinReach
                ? `${role.name} includes permissions you don't hold yourself`
                : has
                  ? `Remove ${role.name}`
                  : `Give ${role.name}`
            }
            disabled={busyRoleId === role.id || !withinReach}
            onClick={() => void toggle(role.id, has)}
          >
            {role.name}
          </Button>
        );
      })}
      {error && <div className="error-text" style={{ flexBasis: "100%" }}>{error}</div>}
    </div>
  );
}
