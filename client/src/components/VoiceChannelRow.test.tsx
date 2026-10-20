import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Channel, Community } from "../api";
import VoiceChannelRow from "./VoiceChannelRow";

const me = { id: "ME", identity: "@me:chat.example", username: "me", displayName: "Me", avatarUrl: null };
vi.mock("../context/AuthContext", () => ({ useAuth: () => ({ user: me }) }));

const voice = vi.hoisted(() => ({
  value: {} as Record<string, any>,
}));
vi.mock("../context/VoiceContext", () => ({ useVoice: () => voice.value }));

const member = (id: string, displayName: string) => ({ id, identity: `@${id}:chat.example`, username: id, displayName, avatarUrl: null });
const channel = { id: "V1", name: "Lounge", type: "VOICE", topic: null, position: 1 } as unknown as Channel;
const community = (homeserverDomain = "chat.example") =>
  ({ id: "C1", name: "Club", homeserverDomain, members: [member("ME", "Me"), member("A", "Alice"), member("B", "Bob")] }) as unknown as Community;

function setVoice(overrides: Record<string, any> = {}) {
  voice.value = {
    people: {},
    voiceAvailable: () => true,
    session: null,
    speaking: new Set(),
    micOff: new Set(),
    audio: { inputVolume: 100, echoCancellation: true, noiseSuppression: true, autoGainControl: true, outputVolume: 100, people: {} },
    setPerson: vi.fn(),
    setInputVolume: vi.fn(),
    setOutputVolume: vi.fn(),
    join: vi.fn().mockResolvedValue(undefined),
    leave: vi.fn(),
    ...overrides,
  };
}

afterEach(cleanup);

describe("a voice channel in the sidebar", () => {
  it("is something to join, named by the channel", () => {
    setVoice();
    render(<VoiceChannelRow channel={channel} community={community()} />);
    const button = screen.getByRole("button", { name: "Join voice channel Lounge" });
    expect(button.textContent).toContain("Lounge");
    expect(button.getAttribute("title")).toBe("Join this voice channel");
  });

  it("joins when pressed, saying which channel and community", () => {
    setVoice();
    render(<VoiceChannelRow channel={channel} community={community()} />);
    fireEvent.click(screen.getByRole("button", { name: "Join voice channel Lounge" }));
    expect(voice.value.join).toHaveBeenCalledWith({ id: "V1", communityId: "C1" });
    expect(voice.value.leave).not.toHaveBeenCalled();
  });

  it("leaves when pressed in the call the person is in", () => {
    setVoice({ session: { channelId: "V1", muted: false } });
    render(<VoiceChannelRow channel={channel} community={community()} />);
    fireEvent.click(screen.getByRole("button", { name: "Leave voice channel Lounge" }));
    expect(voice.value.leave).toHaveBeenCalled();
    expect(voice.value.join).not.toHaveBeenCalled();
  });

  it("is not the one joined when the person is in another channel's call", () => {
    setVoice({ session: { channelId: "OTHER", muted: false } });
    render(<VoiceChannelRow channel={channel} community={community()} />);
    expect(screen.getByRole("button", { name: "Join voice channel Lounge" })).not.toBeNull();
  });

  it("shows who is in it, without joining, and how many", () => {
    setVoice({ people: { V1: ["A", "B"] } });
    render(<VoiceChannelRow channel={channel} community={community()} />);
    const list = screen.getByRole("list", { name: "In Lounge" });
    expect(within(list).getAllByRole("listitem").map((li) => li.querySelector(".voice-person-name")?.textContent)).toEqual(["Alice", "Bob"]);
    expect(document.querySelector(".voice-count")?.textContent).toBe("2");
  });

  it("shows nothing for someone who is not a member of the community (it cannot say who they are)", () => {
    setVoice({ people: { V1: ["A", "STRANGER"] } });
    render(<VoiceChannelRow channel={channel} community={community()} />);
    expect(within(screen.getByRole("list", { name: "In Lounge" })).getAllByRole("listitem")).toHaveLength(1);
    expect(document.querySelector(".voice-count")?.textContent).toBe("1");
  });

  it("shows no list and no count for an empty channel", () => {
    setVoice({ people: { V1: [] } });
    render(<VoiceChannelRow channel={channel} community={community()} />);
    expect(screen.queryByRole("list")).toBeNull();
    expect(document.querySelector(".voice-count")).toBeNull();
  });

  it("outlines whoever is speaking, and says so in words, only in the call this person is in", () => {
    setVoice({ people: { V1: ["A", "B"] }, session: { channelId: "V1", muted: false }, speaking: new Set(["A"]) });
    const { unmount } = render(<VoiceChannelRow channel={channel} community={community()} />);
    const [alice, bob] = screen.getAllByRole("listitem");
    expect(alice.className).toContain("speaking");
    expect(alice.textContent).toContain("(speaking)");
    expect(bob.className).not.toContain("speaking");
    unmount();

    // Not in the call: LiveKit only tells those in a room who is speaking, so nothing is claimed.
    setVoice({ people: { V1: ["A"] }, session: null, speaking: new Set(["A"]) });
    render(<VoiceChannelRow channel={channel} community={community()} />);
    expect(screen.getByRole("listitem").className).not.toContain("speaking");
  });

  it("says whose microphone is off, from the call: others from what they do, this person from their own button", () => {
    setVoice({ people: { V1: ["ME", "A", "B"] }, session: { channelId: "V1", muted: true }, micOff: new Set(["A"]) });
    render(<VoiceChannelRow channel={channel} community={community()} />);
    const [mine, alice, bob] = screen.getAllByRole("listitem");
    expect(within(mine).queryByRole("img", { name: "microphone off" })).not.toBeNull();
    expect(within(alice).queryByRole("img", { name: "microphone off" })).not.toBeNull();
    expect(within(bob).queryByRole("img", { name: "microphone off" })).toBeNull();
  });

  it("does not claim anyone's microphone is off outside the call", () => {
    setVoice({ people: { V1: ["A"] }, session: null, micOff: new Set(["A"]) });
    render(<VoiceChannelRow channel={channel} community={community()} />);
    expect(screen.queryByRole("img", { name: "microphone off" })).toBeNull();
  });

  it("offers a volume for everyone else in the call you are in, and not for yourself or outside a call", () => {
    setVoice({ people: { V1: ["ME", "A", "B"] }, session: { channelId: "V1", muted: false } });
    const { unmount } = render(<VoiceChannelRow channel={channel} community={community()} />);
    expect(screen.queryByRole("button", { name: "Volume for Alice" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Volume for Bob" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Volume for Me" })).toBeNull();
    unmount();

    setVoice({ people: { V1: ["A"] }, session: null });
    render(<VoiceChannelRow channel={channel} community={community()} />);
    expect(screen.queryByRole("button", { name: "Volume for Alice" })).toBeNull();
  });

  it("cannot be joined where voice is not available, and says so", () => {
    setVoice({ voiceAvailable: () => false });
    render(<VoiceChannelRow channel={channel} community={community()} />);
    const button = screen.getByRole("button", { name: "Join voice channel Lounge" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toBe("Voice isn't available right now.");
  });

  it("cannot be joined from a community on another server, and says why", () => {
    setVoice();
    render(<VoiceChannelRow channel={channel} community={community("far.example")} />);
    const button = screen.getByRole("button", { name: "Join voice channel Lounge" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toMatch(/another server/);
  });

  it("can always be left, even if voice has become unavailable meanwhile", () => {
    setVoice({ voiceAvailable: () => false, session: { channelId: "V1", muted: false } });
    render(<VoiceChannelRow channel={channel} community={community()} />);
    expect((screen.getByRole("button", { name: "Leave voice channel Lounge" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
