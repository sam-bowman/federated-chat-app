import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Message, PublicUser } from "../api";
import MessageList from "./MessageList";

vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api")>()), reportContent: vi.fn().mockResolvedValue({ received: true }) }));

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

const person = (id: string, name: string) =>
  ({ id, identity: `@${name.toLowerCase()}:test`, username: name.toLowerCase(), displayName: name, avatarUrl: null, bio: null, presence: { status: "ONLINE", customStatus: null, lastSeenAt: null } }) as PublicUser;

const said = (id: string, by: PublicUser, over: Partial<Message> = {}): Message =>
  ({ id, sender: by, content: `from ${by.displayName}`, invite: null, emoticons: [], attachments: [], replyTo: null, reactions: [], embeds: [], editedAt: null, deletedAt: null, createdAt: "2026-01-01T00:00:00.000Z", ...over }) as Message;

const me = person("me", "Me");
const kim = person("kim", "Kim");

function show(canReport: boolean | undefined, messages: Message[], reportDomain?: string) {
  return render(<MessageList messages={messages} selfId="me" selfUsername="me" onReact={() => {}} onEdit={async () => {}} onDelete={() => {}} canReport={canReport} reportDomain={reportDomain} />);
}

describe("reporting a message (#58)", () => {
  it("is offered on other people's messages, once each", () => {
    show(true, [said("m1", kim), said("m2", me), said("m3", kim)]);
    expect(screen.getAllByRole("button", { name: "Report message" })).toHaveLength(2);
  });

  it("is not offered on your own, on a deleted one, or where the list is not for reporting", () => {
    show(true, [said("m1", me), said("m2", kim, { deletedAt: "2026-01-02T00:00:00.000Z", content: null })]);
    expect(screen.queryByRole("button", { name: "Report message" })).toBeNull();
    cleanup();
    show(undefined, [said("m1", kim)]);
    expect(screen.queryByRole("button", { name: "Report message" })).toBeNull();
  });

  it("says the report goes to the other server when the messages live on one", () => {
    show(true, [said("m1", kim)], "far.example");
    fireEvent.click(screen.getByRole("button", { name: "Report message" }));
    expect(screen.getByText(/It is sent to far\.example/)).toBeTruthy();
  });

  it("opens the report for that message, naming whose it is", () => {
    show(true, [said("m1", kim)]);
    fireEvent.click(screen.getByRole("button", { name: "Report message" }));

    expect(screen.getByRole("dialog", { name: "Report a message" })).toBeTruthy();
    expect(screen.getByText(/You are reporting Kim's message/)).toBeTruthy();
  });
});
