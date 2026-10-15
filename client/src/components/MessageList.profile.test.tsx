import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Message, PublicUser } from "../api";
import { UserProfileContext } from "../context/userProfile";
import MessageList from "./MessageList";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

const person = (id: string, displayName: string): PublicUser =>
  ({
    id,
    identity: `@${displayName.toLowerCase()}:chat.example`,
    username: displayName.toLowerCase(),
    displayName,
    avatarUrl: null,
    bio: null,
    presence: { status: "ONLINE", customStatus: null, lastSeenAt: null },
  }) as PublicUser;

const alice = person("u1", "Alice");
const bob = person("u2", "Bob");

function message(n: number, sender: PublicUser, minutes = n): Message {
  return {
    id: `m${n}`,
    sender,
    content: `message ${n}`,
    invite: null,
    emoticons: [],
    attachments: [],
    replyTo: null,
    reactions: [],
    editedAt: null,
    deletedAt: null,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, minutes * 10)).toISOString(),
  };
}

function renderList(messages: Message[], communityId?: string) {
  const openProfile = vi.fn();
  render(
    <UserProfileContext.Provider value={{ openProfile }}>
      <MessageList
        messages={messages}
        selfId="u2"
        selfUsername="bob"
        onReact={() => {}}
        onEdit={async () => {}}
        onDelete={() => {}}
        communityId={communityId}
      />
    </UserProfileContext.Provider>
  );
  return openProfile;
}

describe("people in a message list open their profile", () => {
  it("opens the author's profile from their picture", () => {
    const openProfile = renderList([message(1, alice)]);

    fireEvent.click(screen.getByRole("button", { name: "View Alice's profile" }));

    expect(openProfile).toHaveBeenCalledWith(alice, { communityId: undefined });
  });

  it("opens it from their name too", () => {
    const openProfile = renderList([message(1, alice)]);

    fireEvent.click(screen.getByRole("button", { name: "Alice" }));

    expect(openProfile).toHaveBeenCalledWith(alice, { communityId: undefined });
  });

  it("passes the community, so the profile shows their roles there", () => {
    const openProfile = renderList([message(1, alice)], "c1");

    fireEvent.click(screen.getByRole("button", { name: "Alice" }));

    expect(openProfile).toHaveBeenCalledWith(alice, { communityId: "c1" });
  });

  it("opens your own profile from your own messages, which are labelled You", () => {
    const openProfile = renderList([message(1, bob)]);

    fireEvent.click(screen.getByRole("button", { name: "You" }));

    expect(openProfile).toHaveBeenCalledWith(bob, { communityId: undefined });
  });

  it("has one picture and one name per run of messages from the same person, not per message", () => {
    renderList([message(1, alice, 1), message(2, alice, 2), message(3, bob, 3)]);

    expect(screen.getAllByRole("button", { name: "View Alice's profile" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Alice" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "View Bob's profile" })).toHaveLength(1);
  });

  it("names the picture button by the person, with markup in the name as plain text", () => {
    renderList([message(1, person("u3", "<b>Mallory</b>"))]);

    expect(screen.getByRole("button", { name: "View <b>Mallory</b>'s profile" })).toBeTruthy();
    expect(document.querySelector("b")).toBeNull();
  });
});
