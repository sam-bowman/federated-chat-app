import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AccountFooter from "./AccountFooter";

const user = { displayName: "Sam", avatarUrl: null, identity: "@smam_admin:chat.example.site" };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function renderFooter(overrides: Partial<React.ComponentProps<typeof AccountFooter>> = {}) {
  const props = { user, onOpenSettings: vi.fn(), onSignOut: vi.fn(), ...overrides };
  render(<AccountFooter {...props} />);
  return props;
}

describe("AccountFooter", () => {
  it("gives both buttons accessible names (sign out had none)", () => {
    renderFooter();
    expect(screen.getByRole("button", { name: "Settings" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Sign out" })).not.toBeNull();
  });

  it("draws the buttons as SVG icons rather than glyph characters", () => {
    renderFooter();
    for (const name of ["Settings", "Sign out"]) {
      const button = screen.getByRole("button", { name });
      expect(button.querySelector("svg")).not.toBeNull();
      expect(button.textContent).toBe("");
    }
  });

  it("calls the handlers", () => {
    const props = renderFooter();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(props.onOpenSettings).toHaveBeenCalledOnce();
    expect(props.onSignOut).toHaveBeenCalledOnce();
  });

  // jsdom has no layout, so truncation is asserted through the class that carries the
  // ellipsis rules (and the tooltip with the full value); how it looks is checked in a browser.
  it("shows a long identity on its own row, with the full value in a tooltip, outside the button row", () => {
    const longIdentity = "@a_very_long_username_indeed:a-rather-long-homeserver.example.site";
    renderFooter({ user: { ...user, identity: longIdentity } });

    const identity = screen.getByText(longIdentity);
    expect(identity.className).toContain("account-identity");
    expect(identity.getAttribute("title")).toContain(longIdentity);
    expect(identity.closest(".account-name-row")).toBeNull();
    expect(screen.getByRole("button", { name: "Settings" }).closest(".account-name-row")).not.toBeNull();
  });

  it("copies the identity when it is clicked and confirms briefly", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderFooter();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Copy your identity/ }));
    });

    expect(writeText).toHaveBeenCalledWith(user.identity);
    expect(screen.getAllByText("Copied!").length).toBeGreaterThan(0);

    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(screen.queryByText("Copied!")).toBeNull();
    expect(screen.getByText(user.identity)).not.toBeNull();
  });

  it("does not claim success when the clipboard is unavailable", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderFooter();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Copy your identity/ }));
    });

    expect(screen.queryByText("Copied!")).toBeNull();
  });
});
