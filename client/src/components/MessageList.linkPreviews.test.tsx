import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Embed, Message, PublicUser } from "../api";
import { setLinkPreviewsShown } from "../lib/linkPreviews";
import MessageList from "./MessageList";

vi.mock("../context/AppDataContext", () => ({
  useAppData: () => ({ communities: [], refreshCommunities: vi.fn() }),
}));

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const alice = { id: "alice", identity: "@alice:chat.example", username: "alice", displayName: "Alice", avatarUrl: null, bio: null, presence: { status: "ONLINE", customStatus: null, lastSeenAt: null } } as PublicUser;

const embed: Embed = { url: "https://example.com/post", title: "A post", description: "What it says", siteName: "Example" };

function message(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    sender: alice,
    content: "look https://example.com/post",
    invite: null,
    emoticons: [],
    attachments: [],
    embeds: [embed],
    replyTo: null,
    reactions: [],
    editedAt: null,
    deletedAt: null,
    createdAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    ...over,
  };
}

function renderList(messages: Message[], selfId: string, onRemovePreviews?: (id: string) => void) {
  render(
    <MemoryRouter>
      <MessageList
        messages={messages}
        selfId={selfId}
        selfUsername={selfId}
        onReact={vi.fn()}
        onEdit={vi.fn().mockResolvedValue(undefined)}
        onDelete={vi.fn()}
        onRemovePreviews={onRemovePreviews}
      />
    </MemoryRouter>
  );
}

describe("MessageList: link previews", () => {
  it("shows a message's previews under it", () => {
    renderList([message()], "bob");
    expect(screen.getByLabelText("Link preview: example.com")).toBeTruthy();
    expect(screen.getByText("What it says")).toBeTruthy();
  });

  it("copes with a server that sends no previews at all", () => {
    renderList([message({ embeds: undefined })], "bob");
    expect(screen.queryByLabelText(/Link preview/)).toBeNull();
  });

  it("shows none once the person has turned previews off here", () => {
    setLinkPreviewsShown(false);
    renderList([message()], "bob");
    expect(screen.queryByLabelText(/Link preview/)).toBeNull();
  });

  it("shows none under a deleted message", () => {
    renderList([message({ content: null, deletedAt: new Date().toISOString() })], "bob");
    expect(screen.queryByLabelText(/Link preview/)).toBeNull();
  });

  it("lets the author, and only the author, take them off", () => {
    const onRemove = vi.fn();
    renderList([message()], "bob", onRemove);
    expect(screen.queryByRole("button", { name: /Remove the preview/ })).toBeNull();

    cleanup();
    renderList([message()], "alice", onRemove);
    fireEvent.click(screen.getByRole("button", { name: "Remove the preview of example.com" }));
    expect(onRemove).toHaveBeenCalledWith("m1");
  });

  it("offers no remove button where the page gives it nothing to call", () => {
    renderList([message()], "alice");
    expect(screen.queryByRole("button", { name: /Remove the preview/ })).toBeNull();
  });
});
