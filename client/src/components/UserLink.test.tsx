import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicUser } from "../api";
import { UserProfileContext } from "../context/userProfile";
import UserLink from "./UserLink";

afterEach(cleanup);

const sam = { id: "u1", identity: "@sam:x", username: "sam", displayName: "Sam" } as PublicUser;

describe("UserLink", () => {
  it("opens that person's profile when pressed, passing the community it was pressed in", () => {
    const openProfile = vi.fn();
    render(
      <UserProfileContext.Provider value={{ openProfile }}>
        <UserLink user={sam} communityId="c1">
          Sam
        </UserLink>
      </UserProfileContext.Provider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Sam" }));

    expect(openProfile).toHaveBeenCalledWith(sam, { communityId: "c1" });
  });

  it("is a real button that says it opens a dialog, and can be named for a picture-only link", () => {
    render(
      <UserLink user={sam} label="View Sam's profile">
        <span aria-hidden="true">S</span>
      </UserLink>
    );

    const button = screen.getByRole("button", { name: "View Sam's profile" });
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
  });

  it("does nothing, rather than failing, where no profile dialog is provided", () => {
    render(<UserLink user={sam}>Sam</UserLink>);

    expect(() => fireEvent.click(screen.getByRole("button", { name: "Sam" }))).not.toThrow();
  });

  it("does not submit a form it sits in", () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <UserLink user={sam}>Sam</UserLink>
      </form>
    );

    fireEvent.click(screen.getByRole("button", { name: "Sam" }));

    expect(onSubmit).not.toHaveBeenCalled();
  });
});
