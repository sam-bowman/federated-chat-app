import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Message, PublicUser } from "../api";
import MessageList from "./MessageList";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

const person = (id: string, name: string, extra: Partial<PublicUser> = {}) =>
  ({ id, identity: `@${name.toLowerCase()}:test`, username: name.toLowerCase(), displayName: name, avatarUrl: null, bio: null, presence: { status: "ONLINE", customStatus: null, lastSeenAt: null }, ...extra }) as PublicUser;

const said = (id: string, by: PublicUser): Message =>
  ({ id, sender: by, content: `from ${by.displayName}`, invite: null, emoticons: [], attachments: [], replyTo: null, reactions: [], embeds: [], editedAt: null, deletedAt: null, createdAt: "2026-01-01T00:00:00.000Z" }) as Message;

describe("a bot's messages (#132)", () => {
  it("carry a Bot badge beside the name, and a person's do not", () => {
    const helper = person("h", "Helper", { isBot: true });
    const kim = person("k", "Kim");
    render(<MessageList messages={[said("m1", helper), said("m2", kim)]} selfId="me" selfUsername="me" onReact={() => {}} onEdit={async () => {}} onDelete={() => {}} />);
    const first = screen.getByText("from Helper").closest(".message-body") as HTMLElement;
    const second = screen.getByText("from Kim").closest(".message-body") as HTMLElement;
    expect(within(first).getByText("Bot")).toBeTruthy();
    expect(within(second).queryByText("Bot")).toBeNull();
  });
});
