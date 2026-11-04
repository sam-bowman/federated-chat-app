import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Community } from "../api";
import TransferOwnerModal from "./TransferOwnerModal";

vi.mock("../context/AppDataContext", () => ({ useAppData: () => ({ refreshCommunities: vi.fn() }) }));
afterEach(cleanup);

const member = (id: string, extra: Record<string, unknown> = {}) => ({ id, identity: `@${id}:chat.example`, username: id, displayName: id, avatarUrl: null, ...extra });
const community = (members: ReturnType<typeof member>[]) => ({ id: "C1", name: "Club", owner: member("owner"), members: [member("owner"), ...members] }) as unknown as Community;
const open = (c: Community) => render(<TransferOwnerModal community={c} viewer={member("owner")} onClose={() => {}} onTransferred={() => {}} />);

describe("handing a community to someone (#132)", () => {
  it("never offers a bot as the new owner, since nobody could manage a community it owned", () => {
    open(community([member("kim"), member("helper", { isBot: true })]));
    const choices = within(screen.getByRole("radiogroup", { name: "New owner" }));
    expect(choices.getByText("kim")).toBeTruthy();
    expect(choices.queryByText("helper")).toBeNull();
  });

  it("says so when only bots are left to choose from", () => {
    open(community([member("helper", { isBot: true })]));
    expect(screen.getByText(/Only bots are in Club besides you/)).toBeTruthy();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("still says nobody is there when nobody is", () => {
    open(community([]));
    expect(screen.getByText(/Nobody else is in Club yet/)).toBeTruthy();
  });
});
