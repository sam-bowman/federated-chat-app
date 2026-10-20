import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE, getAppearance, setAppearance } from "../lib/appearance";
import AppShell from "./AppShell";

const me = { id: "u1", identity: "@me:chat.example", username: "me", displayName: "Me", avatarUrl: null };

const appData = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("../context/AppDataContext", () => ({ useAppData: () => appData.value }));
vi.mock("../context/AuthContext", () => ({ useAuth: () => ({ user: me, logout: vi.fn() }) }));
// The rail and the footer have their own tests and need contexts of their own.
vi.mock("./CommunityRail", () => ({ default: () => null }));
vi.mock("./AccountFooter", () => ({ default: () => null }));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function renderCommunity(channels: { id: string; name: string; topic: string | null; type?: "TEXT" | "VOICE" }[]) {
  appData.value = {
    conversations: [],
    incomingRequests: [],
    communities: [
      {
        id: "C1",
        name: "Book Club",
        homeserverDomain: "chat.example",
        owner: me,
        members: [me],
        roles: [],
        channels: channels.map((c, position) => ({ type: "TEXT", ...c, position })),
      },
    ],
  };
  render(
    <MemoryRouter initialEntries={["/communities/C1/ch1"]}>
      <Routes>
        <Route path="/communities/:communityId/:channelId?" element={<AppShell />} />
      </Routes>
    </MemoryRouter>
  );
}

const shell = () => document.querySelector(".app-shell") as HTMLElement;
const handle = () => screen.getByRole("separator", { name: "Resize the sidebar" });

describe("the sidebar's width", () => {
  it("is the default 20rem for someone who has never changed it", () => {
    renderCommunity([{ id: "ch1", name: "general", topic: null }]);

    expect(shell().style.getPropertyValue("--sidebar-width")).toBe("20rem");
  });

  it("is the width remembered on this device", () => {
    localStorage.setItem("chat.sidebarWidth", "16.5");
    renderCommunity([{ id: "ch1", name: "general", topic: null }]);

    expect(shell().style.getPropertyValue("--sidebar-width")).toBe("16.5rem");
    expect(handle().getAttribute("aria-valuenow")).toBe("16.5");
  });

  it("falls back to the default when what was remembered is nonsense or out of range", () => {
    localStorage.setItem("chat.sidebarWidth", "banana");
    renderCommunity([{ id: "ch1", name: "general", topic: null }]);
    expect(shell().style.getPropertyValue("--sidebar-width")).toBe("20rem");
    cleanup();

    localStorage.setItem("chat.sidebarWidth", "400");
    renderCommunity([{ id: "ch1", name: "general", topic: null }]);
    expect(shell().style.getPropertyValue("--sidebar-width")).toBe("32rem");
  });

  it("changes with the handle and is remembered for next time", () => {
    renderCommunity([{ id: "ch1", name: "general", topic: null }]);

    fireEvent.keyDown(handle(), { key: "ArrowRight" });
    fireEvent.keyDown(handle(), { key: "ArrowRight" });

    expect(shell().style.getPropertyValue("--sidebar-width")).toBe("22rem");
    expect(localStorage.getItem("chat.sidebarWidth")).toBe("22");
  });

  it("goes back to the default, and forgets the remembered width, on a double click", () => {
    localStorage.setItem("chat.sidebarWidth", "27");
    renderCommunity([{ id: "ch1", name: "general", topic: null }]);

    fireEvent.doubleClick(handle());

    expect(shell().style.getPropertyValue("--sidebar-width")).toBe("20rem");
    expect(localStorage.getItem("chat.sidebarWidth")).toBeNull();
  });

  it("still works when this browser will not let the page store anything", () => {
    const blocked = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const blockedSet = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    renderCommunity([{ id: "ch1", name: "general", topic: null }]);

    fireEvent.keyDown(handle(), { key: "ArrowRight" });

    expect(shell().style.getPropertyValue("--sidebar-width")).toBe("21rem");
    blocked.mockRestore();
    blockedSet.mockRestore();
  });
});

describe("the channel list in the sidebar", () => {
  it("shows a channel's topic as its tooltip, and none for a channel without one", () => {
    renderCommunity([
      { id: "ch1", name: "general", topic: "What we are reading" },
      { id: "ch2", name: "random", topic: null },
      { id: "ch3", name: "blank", topic: "   " },
    ]);

    expect(screen.getByText("# general").closest("a")?.getAttribute("title")).toBe("What we are reading");
    expect(screen.getByText("# random").closest("a")?.hasAttribute("title")).toBe(false);
    expect(screen.getByText("# blank").closest("a")?.hasAttribute("title")).toBe(false);
  });
});

describe("the UI scale keyboard shortcuts", () => {
  const press = (key: string, init: KeyboardEventInit = { ctrlKey: true }) => {
    const event = new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true, ...init });
    window.dispatchEvent(event);
    return event;
  };
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    setAppearance({ ...DEFAULT_APPEARANCE, scale: "auto" });
  });

  it("change the size in the desktop app, and take the key from the webview", () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    setAppearance({ ...DEFAULT_APPEARANCE, scale: 100 });
    renderCommunity([{ id: "ch1", name: "general", topic: null }]);

    const larger = press("=");
    expect(getAppearance().scale).toEqual(110);
    expect(larger.defaultPrevented).toBe(true);

    press("-");
    press("-");
    expect(getAppearance().scale).toEqual(90);

    press("0");
    expect(getAppearance().scale).toEqual("auto");
  });

  it("do nothing in a browser, where Ctrl and + is the browser's own zoom and must not be taken over", () => {
    setAppearance({ ...DEFAULT_APPEARANCE, scale: 100 });
    renderCommunity([{ id: "ch1", name: "general", topic: null }]);

    const event = press("=");

    expect(getAppearance().scale).toEqual(100);
    expect(event.defaultPrevented).toBe(false);
  });

  it("stop listening when the shell goes away", () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    setAppearance({ ...DEFAULT_APPEARANCE, scale: 100 });
    renderCommunity([{ id: "ch1", name: "general", topic: null }]);
    cleanup();

    press("=");

    expect(getAppearance().scale).toEqual(100);
  });
});

describe("the channel list", () => {
  it("lists a voice channel as something to join, not as a page to open (it has no messages), among the others in order", () => {
    renderCommunity([
      { id: "ch1", name: "general", topic: null },
      { id: "ch2", name: "Lounge", topic: null, type: "VOICE" },
      { id: "ch3", name: "random", topic: null },
    ]);

    expect(screen.queryByText("# general")).not.toBeNull();
    expect(screen.queryByText("# random")).not.toBeNull();
    expect(screen.queryByText("# Lounge")).toBeNull();
    expect(screen.queryByRole("button", { name: "Join voice channel Lounge" })).not.toBeNull();
    // No link to a page for it.
    expect(document.querySelector('a[href$="/ch2"]')).toBeNull();
  });
});
