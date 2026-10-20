import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import IncomingCalls from "./IncomingCalls";
import { ConversationCallButton, ConversationCallPeople } from "./ConversationCall";
import { emptyPrefs } from "../lib/notificationPrefs";

const voice = vi.hoisted(() => ({ value: {} as Record<string, any> }));
vi.mock("../context/VoiceContext", () => ({ useVoice: () => voice.value }));
vi.mock("../context/AuthContext", () => ({ useAuth: () => ({ user: { id: "me", identity: "@me:chat.example", presence: { status: voice.value.status ?? "ONLINE" } } }) }));
const prefs = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("../context/NotificationSettingsContext", () => ({ useNotificationSettings: () => ({ prefs: prefs.value }) }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock("react-router-dom", () => ({ useNavigate: () => navigate }));
const sound = vi.hoisted(() => ({ ring: vi.fn(async () => true) }));
vi.mock("../lib/notificationSound", () => ({ playRingTone: sound.ring, RING_EVERY_MS: 2600 }));
const system = vi.hoisted(() => ({ show: vi.fn(async () => true) }));
vi.mock("../lib/systemNotification", () => ({ showSystemNotification: system.show }));
const focus = vi.hoisted(() => ({ focused: false }));
vi.mock("../lib/activeChat", () => ({ isAppFocused: () => focus.focused }));

const person = (id: string, name: string, domain = "chat.example") => ({ id, displayName: name, identity: `@${id}:${domain}`, nickname: null, presence: { status: "ONLINE" } });
const dm = (other = person("bea", "Bea")) => ({ id: "D1", type: "DM", title: null, createdAt: "", members: [person("me", "Me"), other] });
const group = { id: "G1", type: "GROUP", title: "Crew", createdAt: "", members: [person("me", "Me"), person("bea", "Bea"), person("cy", "Cy")] };

function setVoice(overrides: Record<string, any> = {}) {
  voice.value = {
    incoming: [],
    ringing: new Set<string>(),
    people: {},
    session: null,
    speaking: new Set(),
    micOff: new Set(),
    callsOffered: true,
    callsAvailable: true,
    dismissCall: vi.fn(),
    joinCall: vi.fn().mockResolvedValue(undefined),
    leave: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  prefs.value = emptyPrefs();
  focus.focused = false;
  sound.ring.mockClear();
  system.show.mockClear();
  navigate.mockClear();
  setVoice();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the incoming call banner", () => {
  it("is not there with no call", () => {
    const { container } = render(<IncomingCalls />);
    expect(container.firstChild).toBeNull();
  });

  it("says who is calling, in a direct chat and in a group", () => {
    setVoice({ incoming: [{ conversation: dm(), callers: ["Bea"] }, { conversation: group, callers: ["Bea", "Cy"] }] });
    render(<IncomingCalls />);
    expect(screen.getByText(/Bea is calling you/)).not.toBeNull();
    expect(screen.getByText(/Bea, Cy are in a call in Crew/)).not.toBeNull();
  });

  it("joins the call, going to the conversation, or puts it away", () => {
    setVoice({ incoming: [{ conversation: dm(), callers: ["Bea"] }] });
    render(<IncomingCalls />);
    fireEvent.click(screen.getByRole("button", { name: "Join the call in Bea" }));
    expect(voice.value.joinCall).toHaveBeenCalledWith("D1");
    expect(navigate).toHaveBeenCalledWith("/dm/D1");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss the call in Bea" }));
    expect(voice.value.dismissCall).toHaveBeenCalledWith("D1");
  });

  it("rings for a new call, again until it stops, and notifies once when the app is not in front", () => {
    setVoice({ incoming: [{ conversation: dm(), callers: ["Bea"] }], ringing: new Set(["D1"]) });
    const { rerender } = render(<IncomingCalls />);
    expect(sound.ring).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2600);
    expect(sound.ring).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(70_000); // gives up after a minute
    const rungFor = sound.ring.mock.calls.length as number;
    vi.advanceTimersByTime(10_000);
    expect(sound.ring).toHaveBeenCalledTimes(rungFor);
    expect(system.show).toHaveBeenCalledTimes(1);
    expect((system.show.mock.calls as unknown as [[object]])[0][0]).toMatchObject({ title: "Bea is calling", tag: "call:D1" });
    rerender(<IncomingCalls />);
    expect(system.show).toHaveBeenCalledTimes(1);
  });

  it("does not ring for a call that was only found, or on Do not disturb, or when that conversation is muted", () => {
    setVoice({ incoming: [{ conversation: dm(), callers: ["Bea"] }], ringing: new Set() });
    render(<IncomingCalls />);
    expect(sound.ring).not.toHaveBeenCalled();
    cleanup();
    setVoice({ incoming: [{ conversation: dm(), callers: ["Bea"] }], ringing: new Set(["D1"]), status: "DO_NOT_DISTURB" });
    render(<IncomingCalls />);
    expect(sound.ring).not.toHaveBeenCalled();
    expect(system.show).not.toHaveBeenCalled();
  });

  it("shows no system notification while the app is in front (the banner is the notice)", () => {
    focus.focused = true;
    setVoice({ incoming: [{ conversation: dm(), callers: ["Bea"] }], ringing: new Set(["D1"]) });
    render(<IncomingCalls />);
    expect(sound.ring).toHaveBeenCalled();
    expect(system.show).not.toHaveBeenCalled();
  });
});

describe("the call button in a conversation", () => {
  it("is not there on a server without voice", () => {
    setVoice({ callsOffered: false });
    const { container } = render(<ConversationCallButton conversation={dm() as any} />);
    expect(container.firstChild).toBeNull();
  });

  it("starts a call, joins one that is going, and leaves the one you are in", () => {
    render(<ConversationCallButton conversation={dm() as any} />);
    fireEvent.click(screen.getByRole("button", { name: "Start call" }));
    expect(voice.value.joinCall).toHaveBeenCalledWith("D1");
    cleanup();

    setVoice({ people: { D1: ["bea"] } });
    render(<ConversationCallButton conversation={dm() as any} />);
    expect(screen.getByRole("button", { name: "Join call" })).not.toBeNull();
    cleanup();

    setVoice({ people: { D1: ["bea", "me"] }, session: { channelId: "D1" } });
    render(<ConversationCallButton conversation={dm() as any} />);
    fireEvent.click(screen.getByRole("button", { name: "Leave call" }));
    expect(voice.value.leave).toHaveBeenCalled();
  });

  it("is off, and says why, with someone on another server or when voice is not answering", () => {
    render(<ConversationCallButton conversation={dm(person("far", "Far", "far.example")) as any} />);
    const button = screen.getByRole("button", { name: "Start call" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toMatch(/other servers/);
    cleanup();
    setVoice({ callsAvailable: false });
    render(<ConversationCallButton conversation={dm() as any} />);
    expect((screen.getByRole("button", { name: "Start call" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("who is in the conversation's call", () => {
  it("lists them, and nothing when nobody is", () => {
    const { container } = render(<ConversationCallPeople conversation={dm() as any} />);
    expect(container.firstChild).toBeNull();
    cleanup();
    setVoice({ people: { D1: ["bea", "me"] } });
    render(<ConversationCallPeople conversation={dm() as any} />);
    expect(screen.getByRole("list", { name: "In the call" }).querySelectorAll("li")).toHaveLength(2);
  });
});
