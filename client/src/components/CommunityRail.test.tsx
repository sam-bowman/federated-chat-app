import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Community } from "../api";
import CommunityRail from "./CommunityRail";

afterEach(cleanup);

function community(id: string, name: string, extra: Partial<Community> = {}, unread = false): Community {
  return {
    id,
    name,
    description: null,
    iconUrl: null,
    owner: {} as Community["owner"],
    createdAt: "",
    channels: [{ id: `${id}-c`, name: "general", unread } as Community["channels"][number]],
    roles: [],
    members: [],
    ...extra,
  };
}

function renderRail(overrides: Partial<React.ComponentProps<typeof CommunityRail>> = {}) {
  const props = {
    communities: [community("a", "Smoke Test"), community("b", "DM Club")],
    activeCommunityId: undefined,
    atHome: true,
    hasUnreadConversation: false,
    pendingRequestCount: 0,
    onCreateCommunity: vi.fn(),
    ...overrides,
  };
  const view = render(
    <MemoryRouter>
      <CommunityRail {...props} />
    </MemoryRouter>
  );
  return { props, ...view };
}

describe("CommunityRail", () => {
  it("makes Home a different kind of tile from a community, even one named 'DM ...'", () => {
    renderRail();
    const home = screen.getByRole("link", { name: "Friends & DMs" });
    const dmClub = screen.getByRole("link", { name: "DM Club" });

    expect(home.className).toContain("rail-home");
    expect(home.className).not.toContain("rail-community");
    expect(dmClub.className).toContain("rail-community");
    expect(home.textContent).toBe("");
    expect(home.querySelector("svg")).not.toBeNull();
    expect(dmClub.textContent).toBe("DM");
  });

  it("puts a separator between Home and the first community", () => {
    const { container } = renderRail();
    const children = Array.from(container.querySelector(".rail")!.children);
    const homeIndex = children.findIndex((el) => el.classList.contains("rail-home"));
    const separatorIndex = children.findIndex((el) => el.getAttribute("role") === "separator");
    const listIndex = children.findIndex((el) => el.classList.contains("rail-communities"));

    expect(homeIndex).toBeLessThan(separatorIndex);
    expect(separatorIndex).toBeLessThan(listIndex);
  });

  it("gives the create button its own look and an accessible name, outside the scrolling list", () => {
    const { props, container } = renderRail();
    const add = screen.getByRole("button", { name: "Create a community" });

    expect(add.className).toContain("rail-add");
    expect(add.closest(".rail-communities")).toBeNull();
    expect(container.querySelector(".rail-home")!.closest(".rail-communities")).toBeNull();

    fireEvent.click(add);
    expect(props.onCreateCommunity).toHaveBeenCalledOnce();
  });

  it("scrolls only the communities, keeping Home and Create outside the list", () => {
    const many = Array.from({ length: 40 }, (_, i) => community(`c${i}`, `Community ${i}`));
    const { container } = renderRail({ communities: many });
    const list = container.querySelector(".rail-communities")!;

    expect(list.querySelectorAll(".rail-community")).toHaveLength(40);
    expect(list.querySelector(".rail-home, .rail-add")).toBeNull();
  });

  it("marks the selected community with aria-current", () => {
    renderRail({ activeCommunityId: "b", atHome: false });

    expect(screen.getByRole("link", { name: "DM Club" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Smoke Test" }).getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("link", { name: "Friends & DMs" }).getAttribute("aria-current")).toBeNull();
  });

  it("marks Home as the current page when not in a community", () => {
    renderRail({ atHome: true });
    expect(screen.getByRole("link", { name: "Friends & DMs" }).getAttribute("aria-current")).toBe("page");
  });

  it("shows unread messages on Home (it only ever showed on communities before)", () => {
    const { container } = renderRail({ hasUnreadConversation: true });

    expect(screen.getByRole("link", { name: "Friends & DMs, unread messages" })).not.toBeNull();
    expect(container.querySelector(".rail-home .rail-unread-dot")).not.toBeNull();
  });

  it("counts pending friend requests on Home, taking precedence over the unread dot", () => {
    const { container } = renderRail({ hasUnreadConversation: true, pendingRequestCount: 2 });

    const home = screen.getByRole("link", { name: "Friends & DMs, 2 pending friend requests" });
    expect(home.querySelector(".rail-badge")!.textContent).toBe("2");
    expect(container.querySelector(".rail-home .rail-unread-dot")).toBeNull();
  });

  it("caps a large friend request count", () => {
    renderRail({ pendingRequestCount: 25 });
    expect(document.querySelector(".rail-badge")!.textContent).toBe("9+");
  });

  it("uses singular wording for one friend request", () => {
    renderRail({ pendingRequestCount: 1 });
    expect(screen.getByRole("link", { name: "Friends & DMs, 1 pending friend request" })).not.toBeNull();
  });

  it("shows a community's icon when it has one, and initials otherwise", () => {
    renderRail({
      communities: [community("a", "Smoke Test", { iconUrl: "/uploads/icon.png" }), community("b", "Plain")],
    });

    const withIcon = screen.getByRole("link", { name: "Smoke Test" });
    expect(withIcon.querySelector("img.rail-icon")!.getAttribute("src")).toContain("/uploads/icon.png");
    expect(withIcon.textContent).toBe("");
    expect(screen.getByRole("link", { name: "Plain" }).textContent).toBe("PL");
  });

  it("treats a non-http scheme in an icon URL as a harmless path, never as a script URL", () => {
    renderRail({ communities: [community("a", "Evil", { iconUrl: "javascript:alert(1)" })] });
    const src = screen.getByRole("link", { name: "Evil" }).querySelector("img")!.getAttribute("src")!;
    expect(src.startsWith("javascript:")).toBe(false);
  });

  it("flags a community with unread messages in its accessible name", () => {
    renderRail({ communities: [community("a", "Smoke Test", {}, true)] });
    expect(screen.getByRole("link", { name: "Smoke Test, unread messages" })).not.toBeNull();
  });
});
