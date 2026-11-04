import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DeveloperSection from "./DeveloperSection";

const mocks = vi.hoisted(() => ({
  fetchServerInfo: vi.fn(),
  getHomeServer: vi.fn(),
  listBots: vi.fn(),
  createBot: vi.fn(),
  regenerateBotToken: vi.fn(),
  deleteBot: vi.fn(),
}));
vi.mock("../api/discovery", () => ({ fetchServerInfo: mocks.fetchServerInfo }));
vi.mock("../api/client", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api/client")>()), getHomeServer: mocks.getHomeServer }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listBots: mocks.listBots,
  createBot: mocks.createBot,
  regenerateBotToken: mocks.regenerateBotToken,
  deleteBot: mocks.deleteBot,
}));

const presence = { status: "OFFLINE", customStatus: null, lastSeenAt: null };
const bot = (n: number) => ({
  id: `B${n}`,
  identity: `@bot_${n}:chat.example`,
  username: `bot_${n}`,
  displayName: `Bot ${n}`,
  avatarUrl: null,
  bio: null,
  isBot: true,
  presence,
  createdAt: "2026-11-04T00:00:00.000Z",
});

beforeEach(() => {
  mocks.getHomeServer.mockReturnValue({ origin: "https://chat.example" });
  mocks.fetchServerInfo.mockResolvedValue({ botsEnabled: true });
  mocks.listBots.mockResolvedValue({ bots: [], limit: 5 });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Settings -> Developer", () => {
  it("is not offered on a server without bots, and does not ask for any", async () => {
    mocks.fetchServerInfo.mockResolvedValue({ botsEnabled: false });
    const { container } = render(<DeveloperSection />);
    await waitFor(() => expect(mocks.fetchServerInfo).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
    expect(mocks.listBots).not.toHaveBeenCalled();
  });

  it("is not offered when the server cannot be asked", async () => {
    mocks.fetchServerInfo.mockRejectedValue(new Error("down"));
    const { container } = render(<DeveloperSection />);
    await waitFor(() => expect(mocks.fetchServerInfo).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it("lists the bots with a Bot badge", async () => {
    mocks.listBots.mockResolvedValue({ bots: [bot(1), bot(2)], limit: 5 });
    render(<DeveloperSection />);
    const list = await screen.findByRole("list", { name: "Your bots" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getAllByText("Bot")).toHaveLength(2);
    expect(within(list).getByText("@bot_1:chat.example")).toBeTruthy();
  });

  it("makes a bot and shows the token once, until it is dismissed", async () => {
    mocks.createBot.mockResolvedValue({ bot: bot(1), token: "mcb_secrettoken" });
    render(<DeveloperSection />);
    const name = await screen.findByLabelText("Bot name");
    const submit = screen.getByRole("button", { name: "Make a bot" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(name, { target: { value: "My_Bot" } });
    // The name is lower-cased as it is typed, so what is checked and sent is what the server accepts.
    expect((name as HTMLInputElement).value).toBe("my_bot");
    expect(submit.disabled).toBe(false);
    mocks.listBots.mockResolvedValue({ bots: [bot(1)], limit: 5 });
    fireEvent.click(submit);

    await waitFor(() => expect(mocks.createBot).toHaveBeenCalledWith({ username: "my_bot", displayName: undefined }));
    expect((await screen.findByLabelText("Token for Bot 1")).textContent).toBe("mcb_secrettoken");
    expect(screen.getByText(/only time it is shown/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "I have saved it" }));
    expect(screen.queryByText("mcb_secrettoken")).toBeNull();
  });

  it("refuses a name that is too short before asking the server, and says what the server says when it refuses", async () => {
    const { ApiError } = await import("../api/client");
    mocks.createBot.mockRejectedValue(new ApiError(409, { error: "username_taken" }));
    render(<DeveloperSection />);
    const name = await screen.findByLabelText("Bot name");
    const submit = screen.getByRole("button", { name: "Make a bot" }) as HTMLButtonElement;
    fireEvent.change(name, { target: { value: "ab" } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(name, { target: { value: "abc" } });
    fireEvent.click(submit);
    expect(await screen.findByText(/already taken/i)).toBeTruthy();
  });

  it("stops offering to make one at the limit", async () => {
    mocks.listBots.mockResolvedValue({ bots: [bot(1), bot(2)], limit: 2 });
    render(<DeveloperSection />);
    await screen.findByRole("list", { name: "Your bots" });
    fireEvent.change(screen.getByLabelText("Bot name"), { target: { value: "another" } });
    expect((screen.getByRole("button", { name: "Make a bot" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("makes a new token on request and shows it", async () => {
    mocks.listBots.mockResolvedValue({ bots: [bot(1)], limit: 5 });
    mocks.regenerateBotToken.mockResolvedValue({ token: "mcb_newtoken" });
    render(<DeveloperSection />);
    fireEvent.click(await screen.findByRole("button", { name: "New token for Bot 1" }));
    expect((await screen.findByLabelText("Token for Bot 1")).textContent).toBe("mcb_newtoken");
    expect(mocks.regenerateBotToken).toHaveBeenCalledWith("B1");
  });

  it("asks before deleting, and deletes only when confirmed", async () => {
    mocks.listBots.mockResolvedValue({ bots: [bot(1)], limit: 5 });
    mocks.deleteBot.mockResolvedValue(undefined);
    render(<DeveloperSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete Bot 1" }));
    expect(mocks.deleteBot).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(mocks.deleteBot).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete Bot 1" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete bot" }));
    await waitFor(() => expect(mocks.deleteBot).toHaveBeenCalledWith("B1"));
  });
});
