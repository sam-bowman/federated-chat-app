import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Community } from "../api";
import { ApiError } from "../api/client";
import RolesPanel from "./RolesPanel";

const createRole = vi.fn();
const updateRole = vi.fn();
const deleteRole = vi.fn();
vi.mock("../api", () => ({
  createRole: (...args: unknown[]) => createRole(...args),
  updateRole: (...args: unknown[]) => updateRole(...args),
  deleteRole: (...args: unknown[]) => deleteRole(...args),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const KICK = (1n << 4n).toString();
const BAN = (1n << 5n).toString();

const community = {
  id: "C1",
  roles: [
    { id: "r-mod", name: "Moderator", color: "#ff8800", position: 1, permissions: KICK, isDefault: false },
    { id: "r-every", name: "@everyone", color: null, position: 0, permissions: (1n << 7n).toString(), isDefault: true },
  ],
  members: [
    { id: "u1", roleIds: ["r-every", "r-mod"] },
    { id: "u2", roleIds: ["r-every"] },
    { id: "u3", roleIds: ["r-every"] },
  ],
} as unknown as Community;

function renderPanel() {
  const onChanged = vi.fn().mockResolvedValue(undefined);
  const utils = render(<RolesPanel community={community} onChanged={onChanged} />);
  return { ...utils, onChanged };
}

describe("RolesPanel - the list", () => {
  it("shows @everyone first, describes each role's permissions, and counts its members", () => {
    renderPanel();

    const rows = document.querySelectorAll(".friend-request-row");
    expect(rows[0].textContent).toContain("@everyone");
    expect(rows[0].textContent).toContain("Send messages");
    expect(rows[0].textContent).toContain("3 members");
    expect(rows[1].textContent).toContain("Moderator");
    expect(rows[1].textContent).toContain("Kick members");
    expect(rows[1].textContent).toContain("1 member");
  });

  it("can't delete the default role, but can delete others", () => {
    renderPanel();
    const [everyone, moderator] = Array.from(document.querySelectorAll<HTMLElement>(".friend-request-row"));

    expect(within(everyone).queryByText("Delete")).toBeNull();
    expect(within(moderator).getByText("Delete")).toBeTruthy();
  });
});

describe("RolesPanel - creating", () => {
  it("sends the name and the permissions ticked, then refreshes", async () => {
    createRole.mockResolvedValue({});
    const { onChanged } = renderPanel();

    fireEvent.click(screen.getByText("New role"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Enforcer" } });
    fireEvent.click(screen.getByLabelText(/Kick members/));
    fireEvent.click(screen.getByLabelText(/Ban members/));
    fireEvent.click(screen.getByText("Create role"));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(createRole).toHaveBeenCalledWith("C1", {
      name: "Enforcer",
      color: undefined,
      permissions: (BigInt(KICK) | BigInt(BAN)).toString(),
    });
  });

  it("only sends a colour once the user opts into one", async () => {
    createRole.mockResolvedValue({});
    const { onChanged } = renderPanel();

    fireEvent.click(screen.getByText("New role"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Coloured" } });
    fireEvent.click(screen.getByLabelText("Give this role a colour"));
    fireEvent.click(screen.getByText("Create role"));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(createRole).toHaveBeenCalledWith("C1", expect.objectContaining({ color: "#99aab5" }));
  });

  it("won't submit without a name", () => {
    renderPanel();
    fireEvent.click(screen.getByText("New role"));
    expect((screen.getByText("Create role") as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains a refusal for exceeding the user's own permissions, and keeps the form", async () => {
    createRole.mockRejectedValue(new ApiError(403, { error: "role_exceeds_your_permissions" }));
    renderPanel();

    fireEvent.click(screen.getByText("New role"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Too much" } });
    fireEvent.click(screen.getByText("Create role"));

    await screen.findByText(/only manage roles made up of permissions you hold yourself/);
    expect(screen.getByText("Create role")).toBeTruthy(); // still on the form
  });
});

describe("RolesPanel - editing and deleting", () => {
  it("opens an existing role's current settings and saves changes", async () => {
    updateRole.mockResolvedValue({});
    const { onChanged } = renderPanel();

    const moderator = Array.from(document.querySelectorAll<HTMLElement>(".friend-request-row"))[1];
    fireEvent.click(within(moderator).getByText("Edit"));
    expect((screen.getByLabelText(/Kick members/) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(/Ban members/) as HTMLInputElement).checked).toBe(false);

    fireEvent.change(screen.getByDisplayValue("Moderator"), { target: { value: "Mod" } });
    fireEvent.click(screen.getByLabelText(/Ban members/));
    fireEvent.click(screen.getByText("Save role"));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(updateRole).toHaveBeenCalledWith("C1", "r-mod", {
      name: "Mod",
      color: "#ff8800",
      permissions: (BigInt(KICK) | BigInt(BAN)).toString(),
    });
  });

  it("keeps the default role's name fixed, and doesn't send it", async () => {
    updateRole.mockResolvedValue({});
    const { onChanged } = renderPanel();

    const everyone = document.querySelectorAll<HTMLElement>(".friend-request-row")[0];
    fireEvent.click(within(everyone).getByText("Edit"));
    expect((screen.getByDisplayValue("@everyone") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/Send messages/)); // turn it off
    fireEvent.click(screen.getByText("Save role"));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const body = updateRole.mock.calls[0][2];
    expect(body).not.toHaveProperty("name");
    expect(body.permissions).toBe("0");
  });

  it("asks before deleting, saying how many members are affected", async () => {
    deleteRole.mockResolvedValue(undefined);
    const { onChanged } = renderPanel();

    const moderator = Array.from(document.querySelectorAll<HTMLElement>(".friend-request-row"))[1];
    fireEvent.click(within(moderator).getByText("Delete"));
    expect(deleteRole).not.toHaveBeenCalled();
    await screen.findByText(/1 member loses it/);

    fireEvent.click(screen.getAllByText("Delete").find((b) => b.className.includes("btn-danger") && b.closest(".auth-card"))!);

    await waitFor(() => expect(deleteRole).toHaveBeenCalledWith("C1", "r-mod"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});
