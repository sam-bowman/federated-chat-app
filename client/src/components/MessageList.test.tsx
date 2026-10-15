import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, PublicUser } from "../api";
import { ApiError } from "../api/client";
import MessageList from "./MessageList";

// The picker loads its emoji on demand; give it a tiny fixed set.
vi.mock("../lib/emojiData", async (importActual) => ({
  ...(await importActual<typeof import("../lib/emojiData")>()),
  loadEmojiGroups: () =>
    Promise.resolve([{ key: "smileys-emotion", label: "Smileys & emotion", entries: [{ char: "😀", label: "grinning face", tags: [] }] }]),
}));

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
    invite: null,
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

describe("MessageList empty state", () => {
  // Regression test (#115): the empty state used to be a bare element outside
  // .message-list, so it did not flex and the composer rose up under the text
  // instead of staying at the bottom of the window.
  it("renders inside the flexing .message-list so the composer stays pinned to the bottom", () => {
    const { container } = render(
      <MessageList
        messages={[]}
        selfId="u2"
        selfUsername="bob"
        onReact={() => {}}
        onEdit={async () => {}}
        onDelete={() => {}}
      />
    );
    const notice = screen.getByText("No messages yet. Say hello!");
    expect(notice.closest(".message-list")).toBe(container.firstElementChild);
  });
});

describe("MessageList - more reactions", () => {
  // The picker lists recently used emoji, which are kept in localStorage between tests.
  beforeEach(() => localStorage.clear());

  function renderWithReactions(onReact: (id: string, emoji: string, already: boolean) => void | Promise<unknown>, reacted = false) {
    const base = message(1);
    const reactions = reacted ? [{ emoji: "😀", count: 1, users: ["bob"] }] : [];
    return render(
      <MessageList
        messages={[{ ...base, reactions }]}
        selfId="u2"
        selfUsername="bob"
        onReact={onReact}
        onEdit={async () => {}}
        onDelete={() => {}}
      />
    );
  }

  it("opens the emoji picker from the + button after the quick reactions, and reacts with the chosen emoji", async () => {
    const onReact = vi.fn();
    renderWithReactions(onReact);

    fireEvent.click(screen.getByRole("button", { name: "More reactions" }));
    fireEvent.click(await screen.findByRole("button", { name: "grinning face" }));

    expect(onReact).toHaveBeenCalledWith("m1", "😀", false);
    // Choosing one closes the picker.
    expect(screen.queryByRole("dialog", { name: "Emoji picker" })).toBeNull();
  });

  it("takes back your own reaction when you pick the same emoji again", async () => {
    const onReact = vi.fn();
    renderWithReactions(onReact, true);

    fireEvent.click(screen.getByRole("button", { name: "More reactions" }));
    fireEvent.click(await screen.findByRole("button", { name: "grinning face" }));

    expect(onReact).toHaveBeenCalledWith("m1", "😀", true);
  });

  it("closes the picker when the + button is pressed again, rather than closing and reopening it", async () => {
    renderWithReactions(vi.fn());
    const plus = screen.getByRole("button", { name: "More reactions" });

    fireEvent.click(plus);
    await screen.findByRole("dialog", { name: "Emoji picker" });
    fireEvent.mouseDown(plus); // the picker ignores a press on its own trigger...
    fireEvent.click(plus); // ...so the click is what toggles it off
    expect(screen.queryByRole("dialog", { name: "Emoji picker" })).toBeNull();
  });

  it("says why when a reaction is refused, and clears the message after a while", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const refused = new ApiError(409, { error: "too_many_reactions" });
      renderWithReactions(vi.fn().mockRejectedValue(refused));

      fireEvent.click(document.querySelector(".message-actions .message-action")!);

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("maximum number of different reactions");

      await act(async () => {
        vi.advanceTimersByTime(5100);
      });
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to a generic message for other failures", async () => {
    renderWithReactions(vi.fn().mockRejectedValue(new Error("offline")));
    fireEvent.click(document.querySelector(".message-actions .message-action")!);

    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't add that reaction.");
  });
});
