import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Community, Conversation, Message } from "../api";
import { emptyPrefs, indexPrefs, type PrefsIndex } from "../lib/notificationPrefs";

const h = vi.hoisted(() => ({
  handlers: {} as Record<string, (payload: unknown) => void>,
  user: { id: "me", presence: { status: "ONLINE" } } as { id: string; presence?: { status: string } } | null,
  conversations: [] as unknown[],
  communities: [] as unknown[],
  prefs: null as unknown,
  focused: true,
  navigate: vi.fn(),
  playSound: vi.fn(),
  showNotification: vi.fn(),
  unlockInstalled: vi.fn(),
  unlockRemoved: vi.fn(),
}));

vi.mock("../context/WsContext", () => ({
  useWs: () => ({
    subscribe: (type: string, handler: (payload: unknown) => void) => {
      h.handlers[type] = handler;
      return () => delete h.handlers[type];
    },
  }),
}));
vi.mock("../context/AuthContext", () => ({ useAuth: () => ({ user: h.user }) }));
vi.mock("../context/AppDataContext", () => ({ useAppData: () => ({ conversations: h.conversations, communities: h.communities }) }));
vi.mock("../context/NotificationSettingsContext", () => ({ useNotificationSettings: () => ({ prefs: h.prefs }) }));
vi.mock("react-router-dom", () => ({ useNavigate: () => h.navigate }));
vi.mock("../lib/activeChat", async (importActual) => ({ ...(await importActual<typeof import("../lib/activeChat")>()), isAppFocused: () => h.focused }));
vi.mock("../lib/notificationSound", () => ({
  installAudioUnlock: () => {
    h.unlockInstalled();
    return h.unlockRemoved;
  },
  playNotificationSound: (...args: unknown[]) => h.playSound(...args),
}));
vi.mock("../lib/systemNotification", () => ({ showSystemNotification: (...args: unknown[]) => h.showNotification(...args) }));

import { setActiveChat } from "../lib/activeChat";
import MessageNotifier from "./MessageNotifier";

const sender = { id: "them", displayName: "Alice" };
const message = (extra: Partial<Message> = {}) =>
  ({ id: "m1", sender, content: "hello there", invite: null, attachments: [], deletedAt: null, ...extra }) as unknown as Message;

const community = { id: "co1", name: "Club", channels: [{ id: "ch1", name: "general" }, { id: "ch2", name: "random" }] } as unknown as Community;
const dm = { id: "c1", type: "DM", title: null, members: [{ id: "me" }, sender] } as unknown as Conversation;
const group = { id: "g1", type: "GROUP", title: "Weekend plans", members: [{ id: "me" }, sender] } as unknown as Conversation;

function arrive(payload: { message?: Message; conversationId?: string; channelId?: string; replayed?: boolean }) {
  h.handlers["message:created"](payload);
}

let rerender: () => void = () => {};

beforeEach(() => {
  h.handlers = {};
  h.user = { id: "me", presence: { status: "ONLINE" } };
  h.conversations = [dm, group];
  h.communities = [community];
  h.prefs = emptyPrefs();
  h.focused = true;
  h.navigate.mockReset();
  h.playSound.mockReset().mockResolvedValue(true);
  h.showNotification.mockReset().mockResolvedValue(true);
  h.unlockInstalled.mockReset();
  h.unlockRemoved.mockReset();
  setActiveChat(null);
  const view = render(<MessageNotifier />);
  rerender = () => view.rerender(<MessageNotifier />);
});

afterEach(() => {
  cleanup();
  setActiveChat(null);
});

describe("MessageNotifier", () => {
  // Catching up (after being away, or after the connection dropped and came back) hands back events, including ones that already
  // made their sound live: alerting for them again was a real bug (a second tab got the first message's alert twice).
  it("does nothing for a message that is being replayed while catching up, and still alerts for a live one", () => {
    arrive({ message: message(), conversationId: "c1", replayed: true });
    expect(h.playSound).not.toHaveBeenCalled();
    expect(h.showNotification).not.toHaveBeenCalled();

    arrive({ message: message(), conversationId: "c1" });
    expect(h.playSound).toHaveBeenCalledTimes(1);
    expect(h.showNotification).toHaveBeenCalledTimes(1);
  });

  it("wakes the audio engine on the first click or key press (a browser allows sound only after one), and stops when it goes away", () => {
    expect(h.unlockInstalled).toHaveBeenCalledOnce();
    cleanup();
    expect(h.unlockRemoved).toHaveBeenCalled();
  });

  it("makes a sound and shows a notification for a direct message, titled with who sent it", () => {
    arrive({ message: message(), conversationId: "c1" });
    expect(h.playSound).toHaveBeenCalledOnce();
    expect(h.showNotification).toHaveBeenCalledOnce();
    expect(h.showNotification.mock.calls[0][0]).toMatchObject({ title: "Alice", body: "hello there", tag: "c:c1" });
  });

  it("names the group in a group chat's notification", () => {
    arrive({ message: message(), conversationId: "g1" });
    expect(h.showNotification.mock.calls[0][0].title).toBe("Alice in Weekend plans");
  });

  it("names the channel and the community for a channel message, found from the communities the person is in", () => {
    arrive({ message: message(), channelId: "ch2" });
    expect(h.showNotification.mock.calls[0][0]).toMatchObject({ title: "Alice in #random (Club)", body: "hello there", tag: "h:ch2" });
  });

  it("still makes the sound for a channel it does not know yet, under the global choice", () => {
    arrive({ message: message(), channelId: "brand-new" });
    expect(h.playSound).toHaveBeenCalledOnce();
    expect(h.showNotification).toHaveBeenCalledOnce();
  });

  it("does nothing for your own message", () => {
    arrive({ message: message({ sender: { id: "me", displayName: "Me" } as never }), conversationId: "c1" });
    expect(h.playSound).not.toHaveBeenCalled();
    expect(h.showNotification).not.toHaveBeenCalled();
  });

  it("does nothing while you are on Do not disturb", () => {
    h.user = { id: "me", presence: { status: "DO_NOT_DISTURB" } };
    rerender();
    arrive({ message: message(), conversationId: "c1" });
    expect(h.playSound).not.toHaveBeenCalled();
    expect(h.showNotification).not.toHaveBeenCalled();
  });

  it("does nothing for the conversation that is open while the app has focus", () => {
    setActiveChat({ conversationId: "c1" });
    arrive({ message: message(), conversationId: "c1" });
    expect(h.playSound).not.toHaveBeenCalled();
    expect(h.showNotification).not.toHaveBeenCalled();
  });

  it("does nothing for the channel that is open while the app has focus, but alerts for another channel", () => {
    setActiveChat({ channelId: "ch1", communityId: "co1" });
    arrive({ message: message(), channelId: "ch1" });
    expect(h.playSound).not.toHaveBeenCalled();
    arrive({ message: message(), channelId: "ch2" });
    expect(h.playSound).toHaveBeenCalledOnce();
    expect(h.showNotification).toHaveBeenCalledOnce();
  });

  it("alerts for the open conversation when the app does not have focus", () => {
    setActiveChat({ conversationId: "c1" });
    h.focused = false;
    arrive({ message: message(), conversationId: "c1" });
    expect(h.playSound).toHaveBeenCalledOnce();
    expect(h.showNotification).toHaveBeenCalledOnce();
  });

  it("takes the sound and the notification separately from what the person chose", () => {
    h.prefs = indexPrefs([{ type: "CONVERSATION", id: "c1", sound: false, notify: null }]) satisfies PrefsIndex;
    rerender();
    arrive({ message: message(), conversationId: "c1" });
    expect(h.playSound).not.toHaveBeenCalled();
    expect(h.showNotification).toHaveBeenCalledOnce();

    h.showNotification.mockClear();
    h.prefs = indexPrefs([{ type: "COMMUNITY", id: "co1", sound: null, notify: false }]);
    rerender();
    arrive({ message: message(), channelId: "ch1" });
    expect(h.playSound).toHaveBeenCalledOnce();
    expect(h.showNotification).not.toHaveBeenCalled();
  });

  it("shortens a long message, and describes one with no text", () => {
    arrive({ message: message({ content: "x".repeat(500) }), conversationId: "c1" });
    expect(h.showNotification.mock.calls[0][0].body).toHaveLength(140);
    expect(h.showNotification.mock.calls[0][0].body.endsWith("…")).toBe(true);

    arrive({ message: message({ content: null, attachments: [{ id: "a" } as never] }), conversationId: "c1" });
    expect(h.showNotification.mock.calls[1][0].body).toBe("sent an attachment");
    arrive({ message: message({ content: "  ", attachments: [] }), conversationId: "c1" });
    expect(h.showNotification.mock.calls[2][0].body).toBe("sent a message");
    arrive({ message: message({ invite: { communityId: "x", domain: "d", name: "n" } as never }), conversationId: "c1" });
    expect(h.showNotification.mock.calls[3][0].body).toBe("sent a community invitation");
  });

  it("takes you to the conversation or channel when the notification is clicked", () => {
    arrive({ message: message(), conversationId: "c1" });
    h.showNotification.mock.calls[0][0].onClick();
    expect(h.navigate).toHaveBeenLastCalledWith("/dm/c1");

    arrive({ message: message(), channelId: "ch2" });
    h.showNotification.mock.calls[1][0].onClick();
    expect(h.navigate).toHaveBeenLastCalledWith("/communities/co1/ch2");
  });

  it("ignores an event with no message, or no place", () => {
    arrive({});
    arrive({ message: message() });
    expect(h.playSound).not.toHaveBeenCalled();
    expect(h.showNotification).not.toHaveBeenCalled();
  });

  it("does nothing when nobody is signed in", () => {
    h.user = null;
    rerender();
    arrive({ message: message(), conversationId: "c1" });
    expect(h.playSound).not.toHaveBeenCalled();
  });

  it("uses the latest choices after they change, with the one subscription it set up at the start", () => {
    arrive({ message: message(), conversationId: "c1" });
    expect(h.playSound).toHaveBeenCalledTimes(1);

    h.prefs = indexPrefs([{ type: "GLOBAL", id: null, sound: false, notify: false }]);
    rerender();
    arrive({ message: message(), conversationId: "c1" });
    expect(h.playSound).toHaveBeenCalledTimes(1);
    expect(h.showNotification).toHaveBeenCalledTimes(1);
  });
});
