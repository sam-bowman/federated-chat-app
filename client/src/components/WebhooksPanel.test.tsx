import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Community } from "../api";
import { ApiError } from "../api/client";
import WebhooksPanel from "./WebhooksPanel";

const mocks = vi.hoisted(() => ({
  fetchServerInfo: vi.fn(),
  getHomeServer: vi.fn(),
  listWebhooks: vi.fn(),
  createWebhook: vi.fn(),
  updateWebhook: vi.fn(),
  rotateWebhookUrl: vi.fn(),
  deleteWebhook: vi.fn(),
  uploadFile: vi.fn(),
}));
vi.mock("../api/discovery", () => ({ fetchServerInfo: mocks.fetchServerInfo }));
vi.mock("../api/client", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api/client")>()), getHomeServer: mocks.getHomeServer }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listWebhooks: mocks.listWebhooks,
  createWebhook: mocks.createWebhook,
  updateWebhook: mocks.updateWebhook,
  rotateWebhookUrl: mocks.rotateWebhookUrl,
  deleteWebhook: mocks.deleteWebhook,
  uploadFile: mocks.uploadFile,
}));

const community = {
  id: "C1",
  name: "Club",
  channels: [
    { id: "ch1", name: "general", topic: null, type: "TEXT", position: 0 },
    { id: "ch2", name: "alerts", topic: null, type: "TEXT", position: 1 },
    { id: "vc", name: "lounge", topic: null, type: "VOICE", position: 2 },
  ],
} as unknown as Community;

const maker = { id: "U1", identity: "@olive:chat.example", username: "olive", displayName: "Olive", avatarUrl: null, bio: null, presence: { status: "OFFLINE", customStatus: null, lastSeenAt: null } };
const webhook = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `W${n}`,
  name: `Hook ${n}`,
  avatarUrl: null,
  channelId: n === 2 ? "ch2" : "ch1",
  createdAt: "2026-11-05T00:00:00.000Z",
  lastUsedAt: null,
  createdBy: maker,
  ...extra,
});
const ADDRESS = "https://chat.example/api/v1/webhooks/W1/mcw_" + "a".repeat(43);

const writeText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  mocks.getHomeServer.mockReturnValue({ origin: "https://chat.example" });
  mocks.fetchServerInfo.mockResolvedValue({ webhooksEnabled: true });
  mocks.listWebhooks.mockResolvedValue({ webhooks: [], limit: 10 });
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const makeForm = () => screen.getByRole("heading", { name: "Make a webhook" }).nextElementSibling as HTMLElement;

describe("Integrations: the webhooks list", () => {
  it("asks for this community's webhooks and says when there are none", async () => {
    render(<WebhooksPanel community={community} />);
    expect(await screen.findByText("This community has no webhooks yet.")).toBeTruthy();
    expect(mocks.listWebhooks).toHaveBeenCalledWith("C1");
  });

  it("shows each one with its channel, who made it, when it was last used, and the Bot mark", async () => {
    mocks.listWebhooks.mockResolvedValue({
      webhooks: [webhook(1), webhook(2, { lastUsedAt: "2026-11-05T10:00:00.000Z", createdBy: null })],
      limit: 10,
    });
    render(<WebhooksPanel community={community} />);
    const list = await screen.findByRole("list", { name: "Webhooks" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Hook 1");
    expect(rows[0].textContent).toContain("Posts in #general");
    expect(rows[0].textContent).toContain("made by Olive");
    expect(rows[0].textContent).toContain("never used");
    expect(rows[0].textContent).toContain("Bot");
    expect(rows[1].textContent).toContain("Posts in #alerts");
    expect(rows[1].textContent).toContain("last used");
    expect(rows[1].textContent).not.toContain("made by");
  });

  it("says so, instead of a blank page, when the list cannot be loaded", async () => {
    mocks.listWebhooks.mockRejectedValue(new ApiError(403, { error: "forbidden" }));
    render(<WebhooksPanel community={community} />);
    expect(await screen.findByText(/Manage webhooks permission/)).toBeTruthy();
  });

  it("names a webhook's channel as gone when it is not one of the text channels", async () => {
    mocks.listWebhooks.mockResolvedValue({ webhooks: [webhook(1, { channelId: "deleted" })], limit: 10 });
    render(<WebhooksPanel community={community} />);
    expect(await screen.findByText(/Posts in #a channel that is gone/)).toBeTruthy();
  });
});

describe("Integrations: making a webhook", () => {
  it("offers only the text channels, and needs a name", async () => {
    render(<WebhooksPanel community={community} />);
    await screen.findByText("This community has no webhooks yet.");
    const select = screen.getByLabelText("Channel") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(["#general", "#alerts"]);

    const button = screen.getByRole("button", { name: "Make a webhook" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Webhook name"), { target: { value: "   " } });
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Webhook name"), { target: { value: "Deploys" } });
    expect(button.disabled).toBe(false);
  });

  it("makes it in the chosen channel, shows its address once, and copies it on request", async () => {
    mocks.createWebhook.mockResolvedValue({ webhook: webhook(1, { name: "Deploys" }), url: ADDRESS });
    render(<WebhooksPanel community={community} />);
    await screen.findByText("This community has no webhooks yet.");

    fireEvent.change(screen.getByLabelText("Webhook name"), { target: { value: "  Deploys " } });
    fireEvent.change(screen.getByLabelText("Channel"), { target: { value: "ch2" } });
    fireEvent.click(screen.getByRole("button", { name: "Make a webhook" }));

    await waitFor(() => expect(mocks.createWebhook).toHaveBeenCalledWith("C1", { name: "Deploys", channelId: "ch2", avatarUrl: undefined }));
    expect((await screen.findByLabelText("Address for Deploys")).textContent).toBe(ADDRESS);
    expect(mocks.listWebhooks).toHaveBeenCalledTimes(2); // listed again, so the new one is in the list
    expect((screen.getByLabelText("Webhook name") as HTMLInputElement).value).toBe(""); // ready for the next one

    fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(ADDRESS));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();

    // Once dismissed it is gone, and nothing in the list shows it.
    fireEvent.click(screen.getByRole("button", { name: "I have saved it" }));
    expect(screen.queryByLabelText("Address for Deploys")).toBeNull();
    expect(document.body.textContent).not.toContain("mcw_");
  });

  it("leaves the address on screen to select when the clipboard is not allowed", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    mocks.createWebhook.mockResolvedValue({ webhook: webhook(1, { name: "Deploys" }), url: ADDRESS });
    render(<WebhooksPanel community={community} />);
    await screen.findByText("This community has no webhooks yet.");
    fireEvent.change(screen.getByLabelText("Webhook name"), { target: { value: "Deploys" } });
    fireEvent.click(screen.getByRole("button", { name: "Make a webhook" }));
    await screen.findByLabelText("Address for Deploys");

    fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Copy address" })).toBeTruthy(); // not "Copied"
    expect(screen.getByLabelText("Address for Deploys").textContent).toBe(ADDRESS);
  });

  it.each([
    ["too_many_webhooks", /as many webhooks as the server allows/],
    ["forbidden", /Manage webhooks permission/],
    ["webhooks_disabled", /switched webhooks off/],
    ["channel_not_found", /isn't a text channel/],
    ["invalid_request", /name of 1 to 64 characters/],
  ])("says what is wrong when the server answers %s, and shows no address", async (code, words) => {
    mocks.createWebhook.mockRejectedValue(new ApiError(409, { error: code }));
    render(<WebhooksPanel community={community} />);
    await screen.findByText("This community has no webhooks yet.");
    fireEvent.change(screen.getByLabelText("Webhook name"), { target: { value: "Deploys" } });
    fireEvent.click(screen.getByRole("button", { name: "Make a webhook" }));
    expect(await screen.findByText(words)).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says it could not reach the server when it could not", async () => {
    mocks.createWebhook.mockRejectedValue(new TypeError("network"));
    render(<WebhooksPanel community={community} />);
    await screen.findByText("This community has no webhooks yet.");
    fireEvent.change(screen.getByLabelText("Webhook name"), { target: { value: "Deploys" } });
    fireEvent.click(screen.getByRole("button", { name: "Make a webhook" }));
    expect(await screen.findByText(/Couldn't reach the server/)).toBeTruthy();
  });

  it("stops at the community's limit and says so", async () => {
    mocks.listWebhooks.mockResolvedValue({ webhooks: [webhook(1), webhook(2)], limit: 2 });
    render(<WebhooksPanel community={community} />);
    expect(await screen.findByText(/the most the server allows \(2\)/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Webhook name"), { target: { value: "One more" } });
    expect((screen.getByRole("button", { name: "Make a webhook" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says how many a community may have while there is room", async () => {
    render(<WebhooksPanel community={community} />);
    expect(await screen.findByText("A community may have 10.")).toBeTruthy();
  });

  it("has nowhere to post in a community with no text channel", async () => {
    const voiceOnly = { ...community, channels: [community.channels[2]] } as unknown as Community;
    render(<WebhooksPanel community={voiceOnly} />);
    expect(await screen.findByText("This community has no text channel to post in.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Make a webhook" })).toBeNull();
  });
});

describe("Integrations: a picture for the webhook", () => {
  const choose = (file: File) => {
    const input = makeForm().querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [file] } });
  };
  const png = () => new File(["x"], "face.png", { type: "image/png" });

  it("is uploaded first, and the webhook is made with the address of the upload", async () => {
    mocks.uploadFile.mockResolvedValue({ url: "/uploads/face.png" });
    mocks.createWebhook.mockResolvedValue({ webhook: webhook(1, { name: "Deploys" }), url: ADDRESS });
    render(<WebhooksPanel community={community} />);
    await screen.findByText("This community has no webhooks yet.");
    fireEvent.change(screen.getByLabelText("Webhook name"), { target: { value: "Deploys" } });
    choose(png());
    fireEvent.click(screen.getByRole("button", { name: "Make a webhook" }));

    await waitFor(() => expect(mocks.createWebhook).toHaveBeenCalledWith("C1", { name: "Deploys", channelId: "ch1", avatarUrl: "/uploads/face.png" }));
    expect(mocks.uploadFile).toHaveBeenCalledTimes(1);
  });

  it("refuses a file that is not a picture, before anything is uploaded", async () => {
    render(<WebhooksPanel community={community} />);
    await screen.findByText("This community has no webhooks yet.");
    choose(new File(["x"], "notes.pdf", { type: "application/pdf" }));
    expect(await screen.findByText(/isn't a picture/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Webhook name"), { target: { value: "Deploys" } });
    mocks.createWebhook.mockResolvedValue({ webhook: webhook(1, { name: "Deploys" }), url: ADDRESS });
    fireEvent.click(screen.getByRole("button", { name: "Make a webhook" }));
    await waitFor(() => expect(mocks.createWebhook).toHaveBeenCalledWith("C1", { name: "Deploys", channelId: "ch1", avatarUrl: undefined }));
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });

  it("does not make the webhook when the upload fails, and says why", async () => {
    mocks.uploadFile.mockRejectedValue(new ApiError(413, { error: "payload_too_large" }));
    render(<WebhooksPanel community={community} />);
    await screen.findByText("This community has no webhooks yet.");
    fireEvent.change(screen.getByLabelText("Webhook name"), { target: { value: "Deploys" } });
    choose(png());
    fireEvent.click(screen.getByRole("button", { name: "Make a webhook" }));
    expect(await screen.findByText(/Couldn't use that picture/)).toBeTruthy();
    expect(mocks.createWebhook).not.toHaveBeenCalled();
  });
});

describe("Integrations: when the server has switched webhooks off", () => {
  it("offers no way to make one or to replace an address, says why, and still lets a webhook be deleted", async () => {
    mocks.fetchServerInfo.mockResolvedValue({ webhooksEnabled: false });
    mocks.listWebhooks.mockResolvedValue({ webhooks: [webhook(1)], limit: 10 });
    render(<WebhooksPanel community={community} />);
    expect(await screen.findByText(/has switched webhooks off/)).toBeTruthy();
    await screen.findByRole("list", { name: "Webhooks" });
    expect(screen.queryByRole("heading", { name: "Make a webhook" })).toBeNull();
    expect(screen.queryByRole("button", { name: /New address/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete Hook 1" })).toBeTruthy();
  });

  it("still offers everything when the server's answer cannot be read (the server decides anyway)", async () => {
    mocks.fetchServerInfo.mockRejectedValue(new Error("down"));
    render(<WebhooksPanel community={community} />);
    expect(await screen.findByRole("heading", { name: "Make a webhook" })).toBeTruthy();
    expect(screen.queryByText(/has switched webhooks off/)).toBeNull();
  });
});

describe("Integrations: changing a webhook", () => {
  beforeEach(() => {
    mocks.listWebhooks.mockResolvedValue({ webhooks: [webhook(1)], limit: 10 });
  });

  it("opens its fields as they are, and saves what was changed", async () => {
    mocks.updateWebhook.mockResolvedValue(webhook(1, { name: "CI" }));
    render(<WebhooksPanel community={community} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Hook 1" }));

    const row = screen.getByRole("listitem");
    expect((within(row).getByLabelText("Webhook name") as HTMLInputElement).value).toBe("Hook 1");
    expect((within(row).getByLabelText("Channel") as HTMLSelectElement).value).toBe("ch1");
    fireEvent.change(within(row).getByLabelText("Webhook name"), { target: { value: "CI" } });
    fireEvent.change(within(row).getByLabelText("Channel"), { target: { value: "ch2" } });
    fireEvent.click(within(row).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(mocks.updateWebhook).toHaveBeenCalledWith("C1", "W1", { name: "CI", channelId: "ch2", avatarUrl: undefined }));
    await waitFor(() => expect(within(screen.getByRole("listitem")).queryByLabelText("Webhook name")).toBeNull()); // closed again
    expect(mocks.listWebhooks).toHaveBeenCalledTimes(2);
  });

  it("closes without saving on Cancel, and a failure stays open with its reason", async () => {
    render(<WebhooksPanel community={community} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Hook 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.updateWebhook).not.toHaveBeenCalled();
    expect(within(screen.getByRole("listitem")).queryByLabelText("Webhook name")).toBeNull();

    mocks.updateWebhook.mockRejectedValue(new ApiError(404, { error: "channel_not_found" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Hook 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/isn't a text channel/)).toBeTruthy();
    expect(within(screen.getByRole("listitem")).getByLabelText("Webhook name")).toBeTruthy();
  });

  it("offers to change the picture of one that has one", async () => {
    mocks.listWebhooks.mockResolvedValue({ webhooks: [webhook(1, { avatarUrl: "/uploads/a.png" })], limit: 10 });
    render(<WebhooksPanel community={community} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Hook 1" }));
    expect(screen.getByRole("button", { name: "Change picture" })).toBeTruthy();
  });
});

describe("Integrations: a new address", () => {
  beforeEach(() => {
    mocks.listWebhooks.mockResolvedValue({ webhooks: [webhook(1)], limit: 10 });
  });

  it("asks first, saying the old one stops, and then shows the new one once", async () => {
    mocks.rotateWebhookUrl.mockResolvedValue({ url: ADDRESS });
    render(<WebhooksPanel community={community} />);
    fireEvent.click(await screen.findByRole("button", { name: "New address for Hook 1" }));
    expect(screen.getByText(/old address stops working at once/)).toBeTruthy();
    expect(mocks.rotateWebhookUrl).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Make a new address" }));
    await waitFor(() => expect(mocks.rotateWebhookUrl).toHaveBeenCalledWith("C1", "W1"));
    expect((await screen.findByLabelText("Address for Hook 1")).textContent).toBe(ADDRESS);
  });

  it("does nothing when the question is cancelled", async () => {
    render(<WebhooksPanel community={community} />);
    fireEvent.click(await screen.findByRole("button", { name: "New address for Hook 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.rotateWebhookUrl).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Address for Hook 1")).toBeNull();
  });

  it("says why when it could not, and shows no address", async () => {
    mocks.rotateWebhookUrl.mockRejectedValue(new ApiError(404, { error: "not_found" }));
    render(<WebhooksPanel community={community} />);
    fireEvent.click(await screen.findByRole("button", { name: "New address for Hook 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Make a new address" }));
    expect(await screen.findByText("That webhook no longer exists.")).toBeTruthy();
    expect(screen.queryByLabelText("Address for Hook 1")).toBeNull();
  });
});

describe("Integrations: deleting a webhook", () => {
  beforeEach(() => {
    mocks.listWebhooks.mockResolvedValue({ webhooks: [webhook(1)], limit: 10 });
  });

  it("asks first, saying its messages stay, and then deletes and lists again", async () => {
    mocks.deleteWebhook.mockResolvedValue(undefined);
    render(<WebhooksPanel community={community} />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete Hook 1" }));
    expect(screen.getByText(/messages it posted stay/)).toBeTruthy();
    expect(mocks.deleteWebhook).not.toHaveBeenCalled();

    mocks.listWebhooks.mockResolvedValue({ webhooks: [], limit: 10 });
    fireEvent.click(screen.getByRole("button", { name: "Delete webhook" }));
    await waitFor(() => expect(mocks.deleteWebhook).toHaveBeenCalledWith("C1", "W1"));
    expect(await screen.findByText("This community has no webhooks yet.")).toBeTruthy();
  });

  it("does nothing when the question is cancelled, and says why when it fails", async () => {
    render(<WebhooksPanel community={community} />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete Hook 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.deleteWebhook).not.toHaveBeenCalled();

    mocks.deleteWebhook.mockRejectedValue(new ApiError(403, { error: "forbidden" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Hook 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete webhook" }));
    expect(await screen.findByText(/Manage webhooks permission/)).toBeTruthy();
  });

  it("takes the address of a deleted webhook off the screen too", async () => {
    mocks.rotateWebhookUrl.mockResolvedValue({ url: ADDRESS });
    mocks.deleteWebhook.mockResolvedValue(undefined);
    render(<WebhooksPanel community={community} />);
    fireEvent.click(await screen.findByRole("button", { name: "New address for Hook 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Make a new address" }));
    await screen.findByLabelText("Address for Hook 1");

    fireEvent.click(screen.getByRole("button", { name: "Delete Hook 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete webhook" }));
    await waitFor(() => expect(screen.queryByLabelText("Address for Hook 1")).toBeNull());
  });
});
