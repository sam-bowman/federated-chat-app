import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Message, PublicUser } from "../api";
import MessageList from "./MessageList";

vi.mock("../context/AppDataContext", () => ({ useAppData: () => ({ communities: [], refreshCommunities: vi.fn() }) }));
vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api")>()), mediaUrl: (path: string) => path }));

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

const robo = { id: "robo", identity: "@robo:chat.example", username: "robo", displayName: "Robo", avatarUrl: null, bio: null, isBot: true, presence: { status: "OFFLINE", customStatus: null, lastSeenAt: null } } as PublicUser;

function message(over: Partial<Message> = {}): Message {
  return {
    id: "m1", sender: robo, content: "Here it is", invite: null, emoticons: [], attachments: [], embeds: [], richEmbeds: [], replyTo: null, reactions: [],
    editedAt: null, deletedAt: null, createdAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    interaction: { id: "i1", command: "request", user: { id: "u1", name: "Ann" } },
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

describe("MessageList: the line naming the command a bot's reply answers", () => {
  it("says who used which command, above the reply", () => {
    renderList([message()]);
    const line = document.querySelector(".message-interaction")!;
    expect(line.textContent).toBe("Ann used /request");
    expect(line.compareDocumentPosition(document.querySelector(".message-text")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("is drawn as text, never as markup", () => {
    renderList([message({ interaction: { id: "i1", command: "request", user: { id: "u1", name: "<b>Ann</b>" } } })]);
    expect(document.querySelector(".message-interaction b")).toBeNull();
    expect(document.querySelector(".message-interaction")!.textContent).toBe("<b>Ann</b> used /request");
  });

  it("is not drawn for an ordinary message, one from a server that predates it, or a deleted one", () => {
    renderList([message({ id: "a", interaction: null }), message({ id: "b", interaction: undefined }), message({ id: "c", deletedAt: "2026-01-01T01:00:00.000Z", content: null })]);
    expect(document.querySelector(".message-interaction")).toBeNull();
    expect(screen.getByText("message deleted")).toBeTruthy();
  });
});
