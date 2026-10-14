import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { getRecentAccounts, isRememberEnabled, rememberAccount } from "../lib/recentAccounts";
import RememberedAccountsSection from "./RememberedAccountsSection";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const account = { origin: "https://chat.example.com", domain: "chat.example.com", serverName: "Chat", username: "alice" };

describe("RememberedAccountsSection", () => {
  it("forgets everything that was remembered", () => {
    rememberAccount(account, 1);
    rememberAccount({ ...account, username: "bob" }, 2);
    render(<RememberedAccountsSection />);

    fireEvent.click(screen.getByText("Forget all (2)"));

    expect(getRecentAccounts()).toEqual([]);
    expect((screen.getByText("Nothing remembered") as HTMLButtonElement).disabled).toBe(true);
  });

  it("switches remembering off and on", () => {
    render(<RememberedAccountsSection />);
    const checkbox = screen.getByLabelText("Remember servers and usernames on this device") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    fireEvent.click(checkbox);
    expect(isRememberEnabled()).toBe(false);
    fireEvent.click(checkbox);
    expect(isRememberEnabled()).toBe(true);
  });
});
