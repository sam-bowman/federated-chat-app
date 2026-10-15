import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProfileCard from "./ProfileCard";

afterEach(cleanup);

const base = {
  identity: "@sam:chat.example",
  displayName: "Sam",
  avatarUrl: null,
  bio: null,
  pronouns: null,
  accentColor: null,
  presence: { status: "ONLINE" as const, customStatus: null, lastSeenAt: null },
};

describe("ProfileCard", () => {
  it("shows the name, identity and status", () => {
    render(<ProfileCard user={base} />);

    expect(screen.getByRole("heading", { name: "Sam" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Copy identity, @sam:chat.example/ }).textContent).toBe("@sam:chat.example");
    expect(screen.getByText("Online")).toBeTruthy();
  });

  it("puts the custom status after the status", () => {
    render(<ProfileCard user={{ ...base, presence: { status: "BUSY", customStatus: "in a meeting", lastSeenAt: null } }} />);

    expect(screen.getByText("Busy · in a meeting")).toBeTruthy();
  });

  it("shows pronouns and a bio only when there are some", () => {
    const { rerender } = render(<ProfileCard user={base} />);
    expect(screen.queryByText("About")).toBeNull();

    rerender(<ProfileCard user={{ ...base, pronouns: "they/them", bio: "I like maps" }} />);

    expect(screen.getByText("they/them")).toBeTruthy();
    expect(screen.getByText("About")).toBeTruthy();
    expect(screen.getByText("I like maps")).toBeTruthy();
  });

  // Every field is somebody else's text. The point of this test is that markup in them is shown, not run.
  it("shows markup in a name, bio and pronouns as plain text, never as elements", () => {
    const { container } = render(
      <ProfileCard
        user={{
          ...base,
          displayName: "<b>Bold</b>",
          pronouns: "<i>x</i>",
          bio: '<img src=x onerror="alert(1)"><script>alert(2)</script>',
        }}
      />
    );

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("i")).toBeNull();
    expect(screen.getByText("<b>Bold</b>")).toBeTruthy();
    expect(screen.getByText("<i>x</i>")).toBeTruthy();
    expect(container.querySelector(".profile-bio")?.textContent).toContain("<img src=x");
  });

  it("keeps the line breaks of a bio, which the stylesheet shows with pre-wrap", () => {
    const { container } = render(<ProfileCard user={{ ...base, bio: "one\ntwo" }} />);

    expect(container.querySelector(".profile-bio")?.textContent).toBe("one\ntwo");
  });

  it("applies a valid accent colour as a custom property, and marks the banner as coloured", () => {
    const { container } = render(<ProfileCard user={{ ...base, accentColor: "#e0a030" }} />);

    expect((container.querySelector(".profile-card") as HTMLElement).style.getPropertyValue("--profile-accent")).toBe("#e0a030");
    expect(container.querySelector(".profile-banner")?.getAttribute("data-accent")).toBe("custom");
  });

  it("ignores an accent colour that is not exactly #rrggbb, however it arrived", () => {
    for (const bad of ["red", "#e0a030; position:fixed", "url(javascript:alert(1))"]) {
      const { container, unmount } = render(<ProfileCard user={{ ...base, accentColor: bad }} />);

      expect((container.querySelector(".profile-card") as HTMLElement).style.getPropertyValue("--profile-accent")).toBe("");
      expect(container.querySelector(".profile-banner")?.getAttribute("data-accent")).toBe("default");
      unmount();
    }
  });

  it("shows when they joined, and their roles with the role's colour only if it is a real colour", () => {
    render(
      <ProfileCard
        user={base}
        memberSince="2025-03-15T12:00:00.000Z"
        roles={[
          { id: "r1", name: "Cartographer", color: "#e0a030" },
          { id: "r2", name: "Plain", color: null },
          { id: "r3", name: "Odd", color: "red" },
        ]}
      />
    );

    expect(screen.getByText(/Member since/)).toBeTruthy();
    const roles = screen.getByRole("list", { name: "Roles" });
    expect(roles.children).toHaveLength(3);
    expect((roles.children[0] as HTMLElement).style.getPropertyValue("--role-color")).toBe("#e0a030");
    expect(roles.children[0].className).toContain("profile-role-coloured");
    expect((roles.children[1] as HTMLElement).style.getPropertyValue("--role-color")).toBe("");
    expect((roles.children[2] as HTMLElement).style.getPropertyValue("--role-color")).toBe("");
  });

  it("shows no roles list for someone with none", () => {
    render(<ProfileCard user={base} roles={[]} />);

    expect(screen.queryByRole("list", { name: "Roles" })).toBeNull();
  });

  it("shows a notice and the actions it is given", () => {
    render(
      <ProfileCard user={base} notice="Couldn't load the full profile.">
        <button type="button">Do a thing</button>
      </ProfileCard>
    );

    expect(screen.getByText("Couldn't load the full profile.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Do a thing" })).toBeTruthy();
  });

  it("copies the identity when it is pressed", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<ProfileCard user={base} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Copy identity/ }));
    });

    expect(writeText).toHaveBeenCalledWith("@sam:chat.example");
  });

  it("does not fail when the clipboard is unavailable", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    render(<ProfileCard user={base} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Copy identity/ }));
    });

    expect(screen.getByRole("heading", { name: "Sam" })).toBeTruthy();
  });

  it("works for someone an older server describes without the new fields", () => {
    const old = { ...base } as Partial<typeof base>;
    delete old.pronouns;
    delete old.accentColor;

    render(<ProfileCard user={old as typeof base} />);

    expect(screen.getByRole("heading", { name: "Sam" })).toBeTruthy();
  });
});
