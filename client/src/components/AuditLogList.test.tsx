import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuditEntry, AuditPage } from "../api";
import AuditLogList from "./AuditLogList";

afterEach(cleanup);

const entry = (id: number, over: Partial<AuditEntry> = {}): AuditEntry => ({
  id,
  at: "2026-01-01T12:00:00.000Z",
  source: "api",
  action: "member.kick",
  actor: { id: "u1", label: "@alice:chat.example" },
  community: { id: "c1", name: "Club" },
  target: { type: "user", id: "u2", label: "@bob:chat.example" },
  details: {},
  ...over,
});
const page = (entries: AuditEntry[], next: number | null = null): AuditPage => ({ entries, next });

describe("AuditLogList", () => {
  it("says what happened, one line each, with when and where it came from", async () => {
    const load = vi.fn().mockResolvedValue(page([entry(2, { source: "cli", actor: { id: null, label: "the operator (command line)" }, action: "user.suspend", community: null }), entry(1)]));
    render(<AuditLogList load={load} scope="server" showCommunity />);

    expect(await screen.findByText("@alice:chat.example removed @bob:chat.example from Club")).toBeTruthy();
    expect(screen.getByText("the operator (command line) suspended @bob:chat.example")).toBeTruthy();
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("from the command line");
    // The whole-server view says which community; a line that was not in one says nothing of it.
    expect(items[1].textContent).toContain("in the app · Club");
    expect(items[0].textContent).not.toContain("· Club");
  });

  it("does not say which community in a community's own view", async () => {
    render(<AuditLogList load={vi.fn().mockResolvedValue(page([entry(1)]))} scope="community" />);
    const line = await screen.findByRole("listitem");
    expect(line.textContent).not.toMatch(/· Club/);
  });

  it("draws what a person typed as text, never as markup", async () => {
    const load = vi.fn().mockResolvedValue(page([entry(1, { target: { type: "user", id: "u2", label: "<img src=x onerror=alert(1)>" } })]));
    render(<AuditLogList load={load} scope="server" />);
    expect(await screen.findByText(/<img src=x onerror=alert\(1\)>/)).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
  });

  it("asks for a page of 50, newest first, and offers older ones only while there are some", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(page([entry(3), entry(2)], 2))
      .mockResolvedValueOnce(page([entry(1)], null));
    render(<AuditLogList load={load} scope="server" />);

    await screen.findAllByRole("listitem");
    expect(load).toHaveBeenLastCalledWith({ before: undefined, limit: 50 });
    fireEvent.click(screen.getByRole("button", { name: "Load older" }));
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(3));
    expect(load).toHaveBeenLastCalledWith({ before: 2, limit: 50 });
    expect(screen.queryByRole("button", { name: "Load older" })).toBeNull();
  });

  it("filters by what was done, starting again from the newest", async () => {
    const load = vi.fn().mockResolvedValue(page([entry(1)]));
    render(<AuditLogList load={load} scope="server" />);
    await screen.findByRole("listitem");

    fireEvent.change(screen.getByLabelText("Show"), { target: { value: "member.ban" } });
    await waitFor(() => expect(load).toHaveBeenLastCalledWith({ before: undefined, limit: 50, action: "member.ban" }));
    fireEvent.change(screen.getByLabelText("Done"), { target: { value: "cli" } });
    await waitFor(() => expect(load).toHaveBeenLastCalledWith({ before: undefined, limit: 50, action: "member.ban", source: "cli" }));
  });

  it("offers a community's own view only the moderation actions and no source filter", async () => {
    render(<AuditLogList load={vi.fn().mockResolvedValue(page([]))} scope="community" />);
    await screen.findByText(/Nothing has been recorded/);
    expect(screen.queryByLabelText("Done")).toBeNull();
    const options = [...(screen.getByLabelText("Show") as HTMLSelectElement).options].map((o) => o.text);
    expect(options).toContain("Banned a member");
    expect(options).not.toContain("Suspended an account");
  });

  it("offers the whole-server view everything, and the source filter", async () => {
    render(<AuditLogList load={vi.fn().mockResolvedValue(page([]))} scope="server" />);
    await screen.findByText(/Nothing has been recorded/);
    expect(screen.getByLabelText("Done")).toBeTruthy();
    const options = [...(screen.getByLabelText("Show") as HTMLSelectElement).options].map((o) => o.text);
    expect(options).toContain("Banned a member");
    expect(options).toContain("Suspended an account");
  });

  it("says when there is nothing, and when there is nothing for the filter", async () => {
    render(<AuditLogList load={vi.fn().mockResolvedValue(page([]))} scope="server" />);
    expect(await screen.findByText("Nothing has been recorded yet.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Show"), { target: { value: "member.ban" } });
    expect(await screen.findByText("Nothing has been recorded for that.")).toBeTruthy();
  });

  it("says when it could not load, and keeps what it had", async () => {
    const load = vi.fn().mockResolvedValueOnce(page([entry(2)], 2)).mockRejectedValueOnce(new Error("down"));
    render(<AuditLogList load={load} scope="server" />);
    await screen.findByRole("listitem");
    fireEvent.click(screen.getByRole("button", { name: "Load older" }));
    expect(await screen.findByText("Couldn't load the audit log. Try again.")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("lets only the latest question answer: an older, slower one does not put its lines on screen", async () => {
    let answerFirst!: (p: AuditPage) => void;
    const load = vi
      .fn()
      .mockImplementationOnce(() => new Promise<AuditPage>((resolve) => (answerFirst = resolve)))
      .mockResolvedValue(page([entry(7, { action: "member.ban" })]));
    render(<AuditLogList load={load} scope="server" />);
    fireEvent.change(screen.getByLabelText("Show"), { target: { value: "member.ban" } });
    await screen.findByText(/banned/);

    answerFirst(page([entry(1, { action: "member.kick" })]));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/removed @bob/)).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });
});
