import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Community } from "../api";
import { resetHomeServerStateForTests } from "../api/client";
import CommunityRail from "./CommunityRail";

// mediaUrl() needs a home server to resolve a relative icon path against. Set it explicitly
// rather than relying on client/.env, which CI's clean checkout doesn't have (the same trap
// client.test.ts documents).
beforeEach(() => {
  import.meta.env.VITE_API_URL = "http://localhost:4000";
  resetHomeServerStateForTests();
});

afterEach(() => {
  cleanup();
  resetHomeServerStateForTests();
});

function community(id: string, name: string, extra: Partial<Community> = {}, unread = false): Community {
  return {
    id,
    name,
    description: null,
    iconUrl: null,
    iconText: null,
    iconColor: null,
    homeserverDomain: "chat.example",
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

describe("CommunityRail: the tile", () => {
  const tileOf = (name: string) => screen.getByRole("link", { name });

  it("is the first two letters of the name, in capitals, by default", () => {
    renderRail({ communities: [community("a", "book club")] });

    expect(tileOf("book club").textContent).toBe("BO");
    expect(tileOf("book club").className).not.toContain("rail-tile-coloured");
    expect(tileOf("book club").style.getPropertyValue("--tile-bg")).toBe("");
  });

  it("does not split an emoji in half when the name starts with one", () => {
    renderRail({ communities: [community("a", "🎲Dice")] });

    expect(tileOf("🎲Dice").textContent).toBe("🎲D");
  });

  it("shows the chosen letters instead, as typed", () => {
    renderRail({ communities: [community("a", "Book Club", { iconText: "bC" })] });

    expect(tileOf("Book Club").textContent).toBe("bC");
  });

  it("shows one letter, or three drawn smaller", () => {
    renderRail({
      communities: [community("a", "One", { iconText: "X" }), community("b", "Three", { iconText: "ABC" })],
    });

    expect(tileOf("One").textContent).toBe("X");
    expect(tileOf("One").querySelector(".rail-letters-small")).toBeNull();
    expect(tileOf("Three").textContent).toBe("ABC");
    expect(tileOf("Three").querySelector(".rail-letters-small")).not.toBeNull();
  });

  it("uses the chosen colour, with the text colour that reads on it, passed as custom properties", () => {
    renderRail({
      communities: [
        community("a", "Dark", { iconColor: "#1e1f26" }),
        community("b", "Light", { iconColor: "#e8b84b" }),
      ],
    });

    expect(tileOf("Dark").className).toContain("rail-tile-coloured");
    expect(tileOf("Dark").style.getPropertyValue("--tile-bg")).toBe("#1e1f26");
    expect(tileOf("Dark").style.getPropertyValue("--tile-fg")).toBe("#ffffff");
    expect(tileOf("Light").style.getPropertyValue("--tile-bg")).toBe("#e8b84b");
    expect(tileOf("Light").style.getPropertyValue("--tile-fg")).toBe("#000000");
  });

  it("keeps its colour when it is the selected one", () => {
    renderRail({
      communities: [community("a", "Gold", { iconColor: "#e8b84b" })],
      activeCommunityId: "a",
      atHome: false,
    });

    expect(tileOf("Gold").className).toContain("active");
    expect(tileOf("Gold").className).toContain("rail-tile-coloured");
  });

  it("shows a picture instead of letters and colour when there is one", () => {
    renderRail({
      communities: [community("a", "Pic", { iconUrl: "/uploads/icon.png", iconText: "ZZ", iconColor: "#e8b84b" })],
    });

    expect(tileOf("Pic").querySelector("img")).not.toBeNull();
    expect(tileOf("Pic").textContent).toBe("");
    expect(tileOf("Pic").className).not.toContain("rail-tile-coloured");
  });
});

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
    expect(withIcon.querySelector(".rail-icon img")!.getAttribute("src")).toContain("/uploads/icon.png");
    expect(withIcon.textContent).toBe("");
    expect(screen.getByRole("link", { name: "Plain" }).textContent).toBe("PL");
  });

  it("treats a non-http scheme in an icon URL as a harmless path, never as a script URL", () => {
    renderRail({ communities: [community("a", "Evil", { iconUrl: "javascript:alert(1)" })] });
    const src = screen.getByRole("link", { name: "Evil" }).querySelector("img")!.getAttribute("src")!;
    expect(["http:", "https:"]).toContain(new URL(src).protocol);
  });

  it("flags a community with unread messages in its accessible name", () => {
    renderRail({ communities: [community("a", "Smoke Test", {}, true)] });
    expect(screen.getByRole("link", { name: "Smoke Test, unread messages" })).not.toBeNull();
  });
});

describe("CommunityRail: Browse", () => {
  it("has a way to the directory, after the buttons for making a community", () => {
    renderRail();

    const browse = screen.getByRole("link", { name: "Browse communities" });
    expect(browse.getAttribute("href")).toBe("/browse");
    expect(browse.getAttribute("aria-current")).toBeNull();
  });

  it("is the page you are on at the directory, and then Friends & DMs is not", () => {
    renderRail({ atHome: false, atBrowse: true });

    expect(screen.getByRole("link", { name: "Browse communities" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Friends & DMs" }).getAttribute("aria-current")).toBeNull();
  });

  it("is not a community: it does not count as one of the rail's communities", () => {
    renderRail({ communities: [community("a", "Smoke Test")] });

    expect(screen.getAllByRole("link").map((l) => l.getAttribute("href"))).toEqual(["/friends", "/communities/a", "/browse"]);
  });
});
