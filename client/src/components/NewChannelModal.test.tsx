import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import NewChannelModal from "./NewChannelModal";

const createChannel = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ createChannel }));
const fetchServerInfo = vi.hoisted(() => vi.fn());
vi.mock("../api/discovery", () => ({ fetchServerInfo }));
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  getHomeServer: () => ({ origin: "https://chat.example" }),
}));
const refreshCommunities = vi.hoisted(() => vi.fn());
vi.mock("../context/AppDataContext", () => ({ useAppData: () => ({ refreshCommunities }) }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock("react-router-dom", async (importOriginal) => ({ ...(await importOriginal<typeof import("react-router-dom")>()), useNavigate: () => navigate }));

beforeEach(() => {
  createChannel.mockReset().mockResolvedValue({ id: "NEW", name: "x" });
  refreshCommunities.mockReset().mockResolvedValue(undefined);
  navigate.mockReset();
  fetchServerInfo.mockReset().mockResolvedValue({ voiceEnabled: false });
});
afterEach(cleanup);

function open() {
  const onClose = vi.fn();
  render(
    <MemoryRouter>
      <NewChannelModal communityId="C1" onClose={onClose} />
    </MemoryRouter>
  );
  return { onClose };
}
const fill = (name: string) => fireEvent.change(screen.getByPlaceholderText("channel-name"), { target: { value: name } });
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Create" }));

describe("making a channel on a server without voice", () => {
  it("offers no choice of type, and makes a text channel and opens it", async () => {
    const { onClose } = open();
    await waitFor(() => expect(fetchServerInfo).toHaveBeenCalledWith("https://chat.example"));
    expect(screen.queryByRole("radiogroup", { name: "Channel type" })).toBeNull();
    fill("general");
    submit();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/communities/C1/NEW"));
    expect(createChannel).toHaveBeenCalledWith("C1", "general", undefined, undefined);
    expect(refreshCommunities).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("offers no choice either when the server cannot be asked", async () => {
    fetchServerInfo.mockRejectedValue(new Error("offline"));
    open();
    await waitFor(() => expect(fetchServerInfo).toHaveBeenCalled());
    expect(screen.queryByRole("radiogroup", { name: "Channel type" })).toBeNull();
  });
});

describe("making a channel on a server with voice", () => {
  beforeEach(() => fetchServerInfo.mockResolvedValue({ voiceEnabled: true }));

  it("offers text or voice, starting on text", async () => {
    open();
    const group = await screen.findByRole("radiogroup", { name: "Channel type" });
    expect(group).not.toBeNull();
    expect((screen.getByLabelText("Text") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Voice") as HTMLInputElement).checked).toBe(false);
  });

  it("makes a text channel as before when text is left chosen", async () => {
    open();
    await screen.findByRole("radiogroup", { name: "Channel type" });
    fill("general");
    submit();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/communities/C1/NEW"));
    expect(createChannel).toHaveBeenCalledWith("C1", "general", undefined, undefined);
  });

  it("makes a voice channel, which is not a page to open", async () => {
    const { onClose } = open();
    fireEvent.click(await screen.findByLabelText("Voice"));
    fill("Lounge");
    submit();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(createChannel).toHaveBeenCalledWith("C1", "Lounge", undefined, "VOICE");
    expect(refreshCommunities).toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("can go back to text after trying voice", async () => {
    open();
    fireEvent.click(await screen.findByLabelText("Voice"));
    fireEvent.click(screen.getByLabelText("Text"));
    fill("general");
    submit();
    await waitFor(() => expect(createChannel).toHaveBeenCalled());
    expect(createChannel).toHaveBeenCalledWith("C1", "general", undefined, undefined);
  });

  it("says so when the server turns out to have no voice", async () => {
    createChannel.mockRejectedValue(new ApiError(409, { error: "voice_not_enabled" }));
    const { onClose } = open();
    fireEvent.click(await screen.findByLabelText("Voice"));
    fill("Lounge");
    submit();
    expect(await screen.findByText("Voice isn't set up on this server.")).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("says something went wrong for any other failure", async () => {
    createChannel.mockRejectedValue(new ApiError(500, { error: "internal_error" }));
    open();
    await screen.findByRole("radiogroup", { name: "Channel type" });
    fill("general");
    submit();
    expect(await screen.findByText("Couldn't create channel.")).not.toBeNull();
  });
});
