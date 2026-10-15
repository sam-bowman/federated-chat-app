import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicUser } from "../api";
import { UserProfileProvider } from "./UserProfileProvider";
import { useUserProfile } from "./userProfile";

// The dialog itself has its own tests; here only that the provider opens it for the right person and closes it.
vi.mock("../components/UserProfileModal", () => ({
  default: ({ user, communityId, onClose }: { user: PublicUser; communityId?: string; onClose: () => void }) => (
    <div role="dialog" aria-label="profile">
      {user.displayName} in {communityId ?? "no community"}
      <button type="button" onClick={onClose}>
        close
      </button>
    </div>
  ),
}));

afterEach(cleanup);

const sam = { id: "u1", displayName: "Sam" } as PublicUser;
const kim = { id: "u2", displayName: "Kim" } as PublicUser;

function Opener() {
  const { openProfile } = useUserProfile();
  return (
    <>
      <button type="button" onClick={() => openProfile(sam)}>
        open sam
      </button>
      <button type="button" onClick={() => openProfile(kim, { communityId: "c9" })}>
        open kim
      </button>
    </>
  );
}

const renderOpener = () =>
  render(
    <UserProfileProvider>
      <Opener />
    </UserProfileProvider>
  );

describe("UserProfileProvider", () => {
  it("shows no dialog until a profile is opened", () => {
    renderOpener();

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the dialog for the person, and for the community when one is given", () => {
    renderOpener();

    fireEvent.click(screen.getByText("open sam"));
    expect(screen.getByRole("dialog").textContent).toContain("Sam in no community");

    fireEvent.click(screen.getByText("open kim"));
    expect(screen.getByRole("dialog").textContent).toContain("Kim in c9");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("closes it", () => {
    renderOpener();
    fireEvent.click(screen.getByText("open sam"));

    fireEvent.click(screen.getByText("close"));

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
