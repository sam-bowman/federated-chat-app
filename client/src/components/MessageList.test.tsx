import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Message, PublicUser } from "../api";
import MessageList from "./MessageList";

// jsdom has no layout engine, so scrollIntoView doesn't exist and scroll
// positions can't be asserted here - the "keep the reader's place when older
// messages are prepended" behaviour is verified in a real browser instead.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

const sender: PublicUser = {
  id: "u1",
  identity: "@alice:test",
  username: "alice",
  displayName: "Alice",
  avatarUrl: null,
  bio: null,
  presence: { status: "ONLINE", customStatus: null, lastSeenAt: null },
} as PublicUser;

function message(n: number): Message {
  return {
    id: `m${n}`,
    sender,
    content: `message ${n}`,
    emoticons: [],
    attachments: [],
    replyTo: null,
    reactions: [],
    editedAt: null,
    deletedAt: null,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
  };
}

function renderList(props: { hasMore?: boolean; loadingOlder?: boolean; onLoadOlder?: () => void }) {
  return render(
    <MessageList
      messages={[message(1), message(2)]}
      selfId="u2"
      selfUsername="bob"
      onReact={() => {}}
      onEdit={async () => {}}
      onDelete={() => {}}
      {...props}
    />
  );
}

describe("MessageList - load older messages", () => {
  it("shows no button when there's no more history", () => {
    renderList({ hasMore: false });
    expect(screen.queryByText("Load older messages")).toBeNull();
  });

  it("shows the button when there's more history, and calls onLoadOlder when clicked", () => {
    const onLoadOlder = vi.fn();
    renderList({ hasMore: true, onLoadOlder });

    fireEvent.click(screen.getByText("Load older messages"));

    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it("disables the button and says so while a page is loading", () => {
    renderList({ hasMore: true, loadingOlder: true });

    const button = screen.getByText("Loading…") as HTMLButtonElement;

    expect(button.disabled).toBe(true);
    expect(screen.queryByText("Load older messages")).toBeNull();
  });
});
