import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AddBotForm from "./AddBotForm";

const mocks = vi.hoisted(() => ({ addBotToCommunity: vi.fn() }));
vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api")>()), addBotToCommunity: mocks.addBotToCommunity }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const community = { id: "C1", name: "Club" };

describe("Add a bot to a community", () => {
  it("adds the bot by name, says so, and tells the page to refresh", async () => {
    mocks.addBotToCommunity.mockResolvedValue({ displayName: "Helper" });
    const onAdded = vi.fn();
    render(<AddBotForm community={community} onAdded={onAdded} />);
    const button = screen.getByRole("button", { name: "Add bot" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Add a bot"), { target: { value: "Helper_Bot" } });
    fireEvent.click(button);

    await waitFor(() => expect(mocks.addBotToCommunity).toHaveBeenCalledWith("C1", "helper_bot"));
    expect(await screen.findByText("Helper was added.")).toBeTruthy();
    expect(onAdded).toHaveBeenCalled();
  });

  it.each([
    ["bot_not_found", /no bot with that name/i],
    ["already_member", /already in this community/i],
    ["bot_banned", /banned/i],
    ["forbidden", /Manage community/i],
  ])("says what is wrong when the server answers %s", async (code, words) => {
    const { ApiError } = await import("../api/client");
    mocks.addBotToCommunity.mockRejectedValue(new ApiError(409, { error: code }));
    const onAdded = vi.fn();
    render(<AddBotForm community={community} onAdded={onAdded} />);
    fireEvent.change(screen.getByLabelText("Add a bot"), { target: { value: "helper" } });
    fireEvent.click(screen.getByRole("button", { name: "Add bot" }));
    expect(await screen.findByText(words)).toBeTruthy();
    expect(onAdded).not.toHaveBeenCalled();
  });
});
