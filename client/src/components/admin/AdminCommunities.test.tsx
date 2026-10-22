import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminCommunity, AdminCommunityPage } from "../../api";
import AdminCommunities from "./AdminCommunities";

const mocks = vi.hoisted(() => ({ listAdminCommunities: vi.fn() }));
vi.mock("../../api", () => ({ listAdminCommunities: mocks.listAdminCommunities }));
// The detail panel has its own tests: here it is a stand-in that shows which community was chosen, and lets the test say it changed or is gone.
vi.mock("./AdminCommunityDetailPanel", () => ({
  default: ({ id, onChanged, onGone }: { id: string; onChanged: () => void; onGone: () => void }) => (
    <div data-testid="detail">
      detail of {id}
      <button onClick={onChanged}>changed</button>
      <button onClick={onGone}>gone</button>
    </div>
  ),
}));

const community = (name: string, over: Partial<AdminCommunity> = {}): AdminCommunity => ({
  id: `id-${name}`,
  name,
  owner: "@alice:chat.example",
  members: 3,
  channels: 2,
  visibility: "UNLISTED",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});
const page = (communities: AdminCommunity[], total = communities.length): AdminCommunityPage => ({ communities, total });

beforeEach(() => mocks.listAdminCommunities.mockReset().mockResolvedValue(page([community("Book Club"), community("Chess", { members: 1, channels: 1 })])));
afterEach(cleanup);

describe("the communities list", () => {
  it("lists the first page with names, owners and sizes", async () => {
    render(<AdminCommunities />);
    const rows = await screen.findAllByRole("button", { name: /Owner/ });
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Book Club");
    expect(rows[0].textContent).toContain("Owner @alice:chat.example");
    expect(rows[0].textContent).toContain("3 members · 2 channels");
    expect(rows[0].textContent).toMatch(/3 members · 2 channels$/);
    expect(rows[1].textContent).toMatch(/1 member · 1 channel$/); // the singular, exactly: "1 channels" would also contain it
    expect(mocks.listAdminCommunities).toHaveBeenCalledWith({ search: "", offset: 0, limit: 25 });
    expect(screen.getByRole("status").textContent).toBe("2 communities");
  });

  it("says one community in the singular", async () => {
    mocks.listAdminCommunities.mockResolvedValue(page([community("Only")]));
    render(<AdminCommunities />);
    await screen.findByText("Only");
    expect(screen.getByRole("status").textContent).toBe("1 community");
  });

  it("searches when asked to, taking what was typed with the spaces off, from the first page", async () => {
    render(<AdminCommunities />);
    await screen.findAllByRole("button", { name: /Owner/ });
    fireEvent.change(screen.getByLabelText("Find a community"), { target: { value: "  chess " } });
    expect(mocks.listAdminCommunities).toHaveBeenCalledTimes(1); // typing alone asks nothing
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(mocks.listAdminCommunities).toHaveBeenLastCalledWith({ search: "chess", offset: 0, limit: 25 }));
  });

  it("asks again when Search is pressed again with the same words, and does not wait for an answer that is not coming", async () => {
    mocks.listAdminCommunities.mockResolvedValue(page([]));
    render(<AdminCommunities />);
    expect(await screen.findByText("No communities match.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Find a community"), { target: { value: "ghost" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(mocks.listAdminCommunities).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("No communities match.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Search" })); // the same again
    await waitFor(() => expect(mocks.listAdminCommunities).toHaveBeenCalledTimes(3));
    expect(await screen.findByText("No communities match.")).toBeTruthy();
  });

  it("pages through a long list, and goes back to the first page when the search changes", async () => {
    const many = Array.from({ length: 25 }, (_, i) => community(`C${i}`));
    mocks.listAdminCommunities.mockResolvedValue(page(many, 60));
    render(<AdminCommunities />);
    await screen.findAllByRole("button", { name: /Owner/ });
    expect(screen.getByRole("status").textContent).toBe("1–25 of 60");
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(mocks.listAdminCommunities).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 25 })));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("26–50 of 60"));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("51–60 of 60"));
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Find a community"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(mocks.listAdminCommunities).toHaveBeenLastCalledWith(expect.objectContaining({ search: "x", offset: 0 })));
  });

  it("shows the community chosen, and which one", async () => {
    render(<AdminCommunities />);
    expect(screen.getByText("Choose a community to see it and what you can do about it.")).toBeTruthy();
    fireEvent.click((await screen.findAllByRole("button", { name: /Chess/ }))[0]);
    expect((await screen.findByTestId("detail")).textContent).toContain("detail of id-Chess");
    expect(screen.getByRole("button", { name: /Chess/ }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: /Book Club/ }).getAttribute("aria-current")).toBeNull();
  });

  it("asks for the list again when the community chosen changed, and clears the choice when it is gone", async () => {
    render(<AdminCommunities />);
    fireEvent.click((await screen.findAllByRole("button", { name: /Chess/ }))[0]);
    await screen.findByTestId("detail");
    fireEvent.click(screen.getByRole("button", { name: "changed" }));
    await waitFor(() => expect(mocks.listAdminCommunities).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("detail")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "gone" }));
    await waitFor(() => expect(mocks.listAdminCommunities).toHaveBeenCalledTimes(3));
    expect(screen.queryByTestId("detail")).toBeNull();
    expect(screen.getByText("Choose a community to see it and what you can do about it.")).toBeTruthy();
  });

  it("says when nothing matches, and when it could not load", async () => {
    mocks.listAdminCommunities.mockResolvedValueOnce(page([]));
    const { unmount } = render(<AdminCommunities />);
    expect(await screen.findByText("No communities match.")).toBeTruthy();
    unmount();
    mocks.listAdminCommunities.mockRejectedValueOnce(new Error("down"));
    render(<AdminCommunities />);
    expect(await screen.findByText("Couldn't load the communities. Try again.")).toBeTruthy();
  });

  it("lets only the latest question answer", async () => {
    let answerFirst!: (value: AdminCommunityPage) => void;
    mocks.listAdminCommunities.mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve))).mockResolvedValue(page([community("Newer")]));
    render(<AdminCommunities />);
    fireEvent.change(screen.getByLabelText("Find a community"), { target: { value: "n" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("Newer");
    answerFirst(page([community("Older")]));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("Older")).toBeNull();
    expect(screen.getByText("Newer")).toBeTruthy();
  });

  it("shows what a person typed as text, never as markup", async () => {
    mocks.listAdminCommunities.mockResolvedValue(page([community("<img src=x onerror=alert(1)>")]));
    render(<AdminCommunities />);
    expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
  });
});
