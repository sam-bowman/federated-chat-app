import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicUser } from "../api";
import { ApiError } from "../api/client";
import { resetFederationState, setFederationEnabled } from "../lib/federation";
import NewConversationModal from "./NewConversationModal";

const createConversation = vi.fn();
vi.mock("../api", () => ({ createConversation: (...args: unknown[]) => createConversation(...args) }));

const appData = vi.hoisted(() => ({ friends: [] as unknown[], refreshConversations: vi.fn() }));
vi.mock("../context/AppDataContext", () => ({ useAppData: () => appData }));
vi.mock("../context/AuthContext", () => ({ useAuth: () => ({ user: { id: "me", identity: "@me:chat.example" } }) }));

const person = (name: string, domain: string) =>
  ({ id: name, identity: `@${name}:${domain}`, username: name, displayName: name[0].toUpperCase() + name.slice(1), avatarUrl: null }) as PublicUser;

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function renderModal() {
  render(
    <MemoryRouter initialEntries={["/friends"]}>
      <NewConversationModal onClose={() => {}} />
      <Where />
    </MemoryRouter>
  );
}

beforeEach(() => {
  appData.friends = [person("bob", "chat.example"), person("dave", "far.example")];
  appData.refreshConversations.mockResolvedValue(undefined);
  createConversation.mockResolvedValue({ id: "conv1" });
});
afterEach(() => {
  cleanup();
  resetFederationState();
  vi.clearAllMocks();
});

const box = (name: string) => screen.getByRole("checkbox", { name: new RegExp(name) }) as HTMLInputElement;

describe("NewConversationModal", () => {
  it("lists friends on this server and on others, and starts a direct message with one", async () => {
    renderModal();

    fireEvent.click(box("Bob"));
    fireEvent.click(screen.getByRole("button", { name: "Start conversation" }));

    await waitFor(() => expect(createConversation).toHaveBeenCalledWith("DM", ["@bob:chat.example"]));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/dm/conv1"));
    expect(box("Dave").disabled).toBe(false);
  });

  it("starts a group with several", async () => {
    renderModal();

    fireEvent.click(box("Bob"));
    fireEvent.click(box("Dave"));
    fireEvent.click(screen.getByRole("button", { name: "Start group chat" }));

    await waitFor(() => expect(createConversation).toHaveBeenCalledWith("GROUP", ["@bob:chat.example", "@dave:far.example"]));
  });
});

describe("NewConversationModal on a private server", () => {
  it("cannot select a friend on another server, and says that is why, while a friend here can still be selected", () => {
    setFederationEnabled(false);
    renderModal();

    expect(box("Dave").disabled).toBe(true);
    expect(screen.getByText("@dave:far.example (another server)")).toBeTruthy();
    expect(box("Bob").disabled).toBe(false);
  });

  it("says why if the server refuses all the same (it was turned private since the page loaded)", async () => {
    createConversation.mockRejectedValue(new ApiError(403, { error: "federation_disabled" }));
    renderModal();
    fireEvent.click(box("Dave"));

    fireEvent.click(screen.getByRole("button", { name: "Start conversation" }));

    expect(await screen.findByText(/doesn't connect to other servers/)).toBeTruthy();
  });

  it("says so when only that person's server is off limits", async () => {
    createConversation.mockRejectedValue(new ApiError(403, { error: "federation_domain_blocked" }));
    renderModal();
    fireEvent.click(box("Dave"));

    fireEvent.click(screen.getByRole("button", { name: "Start conversation" }));

    expect(await screen.findByText("This server doesn't connect to that server, so this can't be done.")).toBeTruthy();
  });

  it("keeps the ordinary message for any other failure", async () => {
    createConversation.mockRejectedValue(new ApiError(500, { error: "internal_error" }));
    renderModal();
    fireEvent.click(box("Bob"));

    fireEvent.click(screen.getByRole("button", { name: "Start conversation" }));

    expect(await screen.findByText("Couldn't start conversation.")).toBeTruthy();
  });
});
