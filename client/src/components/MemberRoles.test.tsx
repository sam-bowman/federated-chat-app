import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Community, CommunityMember } from "../api";
import { ApiError } from "../api/client";
import MemberRoles from "./MemberRoles";

const assignRole = vi.fn();
const unassignRole = vi.fn();
vi.mock("../api", () => ({
  assignRole: (...args: unknown[]) => assignRole(...args),
  unassignRole: (...args: unknown[]) => unassignRole(...args),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const community = {
  id: "C1",
  roles: [
    { id: "r-every", name: "@everyone", color: null, position: 0, permissions: "0", isDefault: true },
    { id: "r-mod", name: "Moderator", color: "#ff8800", position: 1, permissions: "16", isDefault: false },
    { id: "r-vip", name: "VIP", color: null, position: 2, permissions: "0", isDefault: false },
  ],
} as unknown as Community;

const member = { id: "u2", roleIds: ["r-every", "r-mod"] } as unknown as CommunityMember;

function renderChips(overrides: { community?: Community; member?: CommunityMember } = {}) {
  const onChanged = vi.fn().mockResolvedValue(undefined);
  const utils = render(
    <MemberRoles community={overrides.community ?? community} member={overrides.member ?? member} onChanged={onChanged} />
  );
  return { ...utils, onChanged };
}

describe("MemberRoles", () => {
  it("offers every role except @everyone, marking the ones the member has", () => {
    renderChips();

    expect(screen.queryByText("@everyone")).toBeNull();
    expect(screen.getByText("Moderator").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("VIP").getAttribute("aria-pressed")).toBe("false");
  });

  it("renders nothing at all when there are no roles beyond @everyone", () => {
    const bare = { id: "C1", roles: [community.roles[0]] } as unknown as Community;
    const { container } = renderChips({ community: bare });
    expect(container.innerHTML).toBe("");
  });

  it("clicking a role the member lacks assigns it, then refreshes", async () => {
    assignRole.mockResolvedValue(undefined);
    const { onChanged } = renderChips();

    fireEvent.click(screen.getByText("VIP"));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(assignRole).toHaveBeenCalledWith("C1", "u2", "r-vip");
    expect(unassignRole).not.toHaveBeenCalled();
  });

  it("clicking a role the member has removes it", async () => {
    unassignRole.mockResolvedValue(undefined);
    const { onChanged } = renderChips();

    fireEvent.click(screen.getByText("Moderator"));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(unassignRole).toHaveBeenCalledWith("C1", "u2", "r-mod");
  });

  it("explains a refusal for exceeding the user's own permissions", async () => {
    assignRole.mockRejectedValue(new ApiError(403, { error: "role_exceeds_your_permissions" }));
    const { onChanged } = renderChips();

    fireEvent.click(screen.getByText("VIP"));

    await screen.findByText(/only assign roles made up of permissions you hold yourself/);
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe("MemberRoles - a delegated manager", () => {
  it("disables a role made of permissions the viewer does not hold, and leaves the others usable", () => {
    const onChanged = vi.fn().mockResolvedValue(undefined);
    render(<MemberRoles community={community} member={member} onChanged={onChanged} viewerPermissions={0n} />);

    // Moderator is Kick members (16), which this viewer lacks; VIP carries no permissions.
    expect((screen.getByText("Moderator") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Moderator").getAttribute("title")).toContain("don't hold");
    expect((screen.getByText("VIP") as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not call the API when a disabled role is clicked", () => {
    const onChanged = vi.fn().mockResolvedValue(undefined);
    render(<MemberRoles community={community} member={member} onChanged={onChanged} viewerPermissions={0n} />);

    fireEvent.click(screen.getByText("Moderator"));

    expect(unassignRole).not.toHaveBeenCalled();
    expect(assignRole).not.toHaveBeenCalled();
  });
});
