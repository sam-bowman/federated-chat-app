import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Message, PublicUser } from "../api";
import MessageList from "./MessageList";

vi.mock("../context/AppDataContext", () => ({
  useAppData: () => ({ communities: [], refreshCommunities: vi.fn() }),
}));
vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api")>()), joinCommunity: vi.fn() }));

// jsdom has no layout, so no scrollIntoView (the list scrolls to the newest message).
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

const alice = { id: "alice", identity: "@alice:chat.example", username: "alice", displayName: "Alice", avatarUrl: null, bio: null, presence: { status: "ONLINE", customStatus: null, lastSeenAt: null } } as PublicUser;
const bob = { ...alice, id: "bob", identity: "@bob:chat.example", username: "bob", displayName: "Bob" } as PublicUser;

function message(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    sender: alice,
    content: "hello",
    invite: null,
    emoticons: [],
    attachments: [],
    replyTo: null,
    reactions: [],
    editedAt: null,
    deletedAt: null,
    createdAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    ...over,
  };
}

const invite = { communityId: "01JCOMMUNITY", domain: "chat.example", name: "Book Club" };
const inviteText = "Invited you to join Book Club (join code: 01JCOMMUNITY:chat.example)";

function renderList(messages: Message[], selfId: string) {
  render(
    <MemoryRouter>
      <MessageList
        messages={messages}
        selfId={selfId}
        selfUsername={selfId}
        onReact={vi.fn()}
        onEdit={vi.fn().mockResolvedValue(undefined)}
        onDelete={vi.fn()}
      />
    </MemoryRouter>
  );
}

describe("MessageList: invitation cards", () => {
  it("shows an invitation as a card with a Join button, not as its text", () => {
    renderList([message({ invite, content: inviteText })], "bob");

    expect(screen.getByText("Alice invited you to join")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Join" })).toBeTruthy();
    expect(screen.queryByText(inviteText)).toBeNull(); // the card replaces the text
  });

  it("shows the sender what they sent, with nothing to join", () => {
    renderList([message({ invite, content: inviteText })], "alice");

    expect(screen.getByText("You invited them to join")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Join" })).toBeNull();
  });

  it("does not offer to edit an invitation, but still to delete your own", () => {
    renderList([message({ invite, content: inviteText })], "alice");

    expect(screen.queryByRole("button", { name: "Edit message" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete message" })).toBeTruthy();
  });

  it("still offers to edit an ordinary message of your own", () => {
    renderList([message()], "alice");

    expect(screen.getByRole("button", { name: "Edit message" })).toBeTruthy();
  });

  it("shows an ordinary message as text, with no card", () => {
    renderList([message({ sender: bob })], "alice");

    expect(screen.getByText("hello")).toBeTruthy();
    expect(document.querySelector(".invite-card")).toBeNull();
  });

  it("shows a deleted invitation as deleted, with no card", () => {
    renderList([message({ invite: null, content: null, deletedAt: "2026-01-01T00:01:00Z" })], "bob");

    expect(screen.getByText("message deleted")).toBeTruthy();
    expect(document.querySelector(".invite-card")).toBeNull();
  });
});
