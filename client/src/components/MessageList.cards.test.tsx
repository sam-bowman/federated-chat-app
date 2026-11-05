import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Message, PublicUser, RichEmbed } from "../api";
import { setLinkPreviewPicturesShown } from "../lib/linkPreviews";
import MessageList from "./MessageList";

vi.mock("../context/AppDataContext", () => ({
  useAppData: () => ({ communities: [], refreshCommunities: vi.fn() }),
}));
// A picture's address is made absolute against the home server, which a test has not resolved (and client/.env, which would, is not in CI).
vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api")>()), mediaUrl: (path: string) => path }));

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const robo = { id: "robo", identity: "@robo:chat.example", username: "robo", displayName: "Robo", avatarUrl: null, bio: null, isBot: true, presence: { status: "OFFLINE", customStatus: null, lastSeenAt: null } } as PublicUser;

const card: RichEmbed = {
  title: "Dune",
  description: "A film",
  url: null,
  color: "#112233",
  fields: [{ name: "Year", value: "2021", inline: true }],
  footer: "via robo",
  image: { url: "https://chat.example/uploads/a.png", width: 640, height: 480 },
};

function message(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    sender: robo,
    content: "",
    invite: null,
    emoticons: [],
    attachments: [],
    embeds: [],
    richEmbeds: [card],
    replyTo: null,
    reactions: [],
    editedAt: null,
    deletedAt: null,
    createdAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    ...over,
  };
}

function renderList(messages: Message[]) {
  render(
    <MemoryRouter>
      <MessageList messages={messages} selfId="me" selfUsername="me" onReact={vi.fn()} onEdit={vi.fn().mockResolvedValue(undefined)} onDelete={vi.fn()} />
    </MemoryRouter>
  );
}

describe("MessageList: a bot's cards", () => {
  it("draws a message that is only cards as the cards, with no text line of its own", () => {
    renderList([message()]);
    expect(screen.getByRole("article", { name: "Card: Dune" })).toBeTruthy();
    expect(document.querySelector(".message-text")).toBeNull();
    // Still marked as a bot's.
    expect(document.querySelector(".message-row")!.textContent).toContain("Bot");
  });

  it("draws the text and then the cards when a message has both", () => {
    renderList([message({ content: "Found it:" })]);
    const row = document.querySelector(".message-row")!;
    expect(row.querySelector(".message-text")!.textContent).toContain("Found it:");
    expect(row.querySelector("article")).not.toBeNull();
    expect(row.querySelector(".message-text")!.compareDocumentPosition(row.querySelector("article")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("still says a card-only message was edited", () => {
    renderList([message({ editedAt: "2026-01-01T01:00:00.000Z" })]);
    expect(screen.getByText("(edited)")).toBeTruthy();
    expect(document.querySelector(".message-text")).toBeNull();
  });

  it("draws nothing for a deleted message, and nothing for an invitation card", () => {
    renderList([message({ deletedAt: "2026-01-01T01:00:00.000Z", content: null, richEmbeds: [card] }), message({ id: "m2", content: "come", invite: { communityId: "c", domain: "d", name: "Club", code: null } as never })]);
    expect(document.querySelector("article")).toBeNull();
  });

  it("draws a message from a server that predates cards (no richEmbeds) as it always did", () => {
    renderList([message({ content: "plain", richEmbeds: undefined })]);
    expect(document.querySelector("article")).toBeNull();
    expect(document.querySelector(".message-text")!.textContent).toContain("plain");
  });

  it("an empty message with no cards (nothing to draw) still draws its (empty) text line, as before", () => {
    renderList([message({ content: "", richEmbeds: [] })]);
    expect(document.querySelector(".message-text")).not.toBeNull();
  });

  it("draws the pictures while this device shows them and leaves them out, keeping the card, when it hides them", () => {
    renderList([message({ content: "x" })]);
    expect(document.querySelector("article img")).not.toBeNull();
    cleanup();
    setLinkPreviewPicturesShown(false);
    renderList([message({ content: "x" })]);
    expect(document.querySelector("article")).not.toBeNull();
    expect(document.querySelector("article img")).toBeNull();
  });

  it("a card that was only a picture is not drawn once pictures are hidden", () => {
    setLinkPreviewPicturesShown(false);
    renderList([message({ content: "text", richEmbeds: [{ title: null, description: null, url: null, color: null, fields: [], footer: null, image: card.image }] })]);
    expect(document.querySelector("article")).toBeNull();
  });
});
