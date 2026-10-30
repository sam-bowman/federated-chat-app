import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Report, ReportPage } from "../api";
import { ApiError } from "../api/client";
import ReportsQueue from "./ReportsQueue";

const api = vi.hoisted(() => ({ listReports: vi.fn(), resolveReport: vi.fn(), dismissReport: vi.fn(), reopenReport: vi.fn() }));
vi.mock("../api", () => api);

const report = (id: string, over: Partial<Report> = {}): Report => ({
  id,
  createdAt: "2026-01-01T12:00:00.000Z",
  kind: "message",
  scope: "community",
  status: "open",
  reason: "spam",
  details: null,
  reporter: { id: "u1", label: "@kim:chat.example", history: { total: 3, dismissed: 1 } },
  target: { id: "m1", userId: "u2", label: "@bob:chat.example" },
  communityId: "c1",
  snapshot: {
    type: "message",
    text: "buy my pills",
    attachments: [],
    attachmentCount: 0,
    sentAt: "2026-01-01T11:00:00.000Z",
    editedAt: null,
    where: { community: "Club", channel: "general" },
    sender: { identity: "@bob:chat.example", displayName: "Bob" },
  },
  resolution: null,
  ...over,
});
const page = (reports: Report[], next: number | null = null, open = reports.filter((r) => r.status === "open").length): ReportPage => ({ reports, next, open });

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.listReports.mockResolvedValue(page([report("r1")]));
});
afterEach(cleanup);

const card = (n = 0) => screen.getAllByRole("listitem")[n];

describe("the queue", () => {
  it("opens on what is still to look at, newest first, and says how many are open", async () => {
    api.listReports.mockResolvedValue(page([report("r2"), report("r1")]));
    render(<ReportsQueue communityId="c1" />);

    await screen.findAllByRole("listitem");
    expect(api.listReports).toHaveBeenCalledWith("c1", { before: undefined, limit: 25, status: "open" });
    expect(screen.getByText("2 open reports")).toBeTruthy();
  });

  it("shows why, by whom and how often they have reported here, and what was reported", async () => {
    render(<ReportsQueue communityId="c1" />);
    const item = await screen.findByRole("listitem");

    expect(within(item).getByText("Spam")).toBeTruthy();
    expect(item.textContent).toContain("Reported by @kim:chat.example (3 reports in this community, 1 dismissed)");
    expect(within(item).getByText("buy my pills")).toBeTruthy();
    expect(item.textContent).toContain("Bob (@bob:chat.example)");
    expect(item.textContent).toContain("# general in Club");
  });

  it("on the admins' queue says where each went and counts across the server", async () => {
    api.listReports.mockResolvedValue(page([report("r1"), report("r2", { scope: "server", kind: "user", communityId: null, snapshot: { type: "user", identity: "@bob:chat.example", displayName: "Bob", bio: "my bio" } })]));
    render(<ReportsQueue communityId={null} />);
    await screen.findAllByRole("listitem");

    expect(api.listReports).toHaveBeenCalledWith(null, expect.anything());
    expect(card(0).textContent).toContain("went to the community's moderators");
    expect(card(1).textContent).toContain("for the admins only");
    expect(card(1).textContent).toContain("3 reports on this server");
    expect(card(1).textContent).toContain("my bio");
  });

  it("draws everything a person wrote as text, never as markup or a link", async () => {
    const evil = "<img src=x onerror=alert(1)> <a href='javascript:alert(2)'>click</a>";
    api.listReports.mockResolvedValue(
      page([report("r1", { details: evil, reporter: { id: "u1", label: evil, history: null }, snapshot: { type: "message", text: evil, attachments: ["https://evil.example/x.png"], attachmentCount: 1 } })])
    );
    render(<ReportsQueue communityId="c1" />);
    await screen.findByLabelText(/report about a message/);

    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("a")).toBeNull();
    expect(screen.getAllByText(/<img src=x onerror=alert\(1\)>/).length).toBeGreaterThan(0);
    // An attachment is its address as text: a reviewer decides whether to open it.
    expect(screen.getByText("https://evil.example/x.png")).toBeTruthy();
  });

  it("says plainly when what was reported is gone because the person deleted their account", async () => {
    api.listReports.mockResolvedValue(page([report("r1", { snapshot: { type: "erased" } })]));
    render(<ReportsQueue communityId="c1" />);
    expect(await screen.findByText(/deleted their account, so what they wrote is no longer kept/)).toBeTruthy();
  });

  it("says when there is nothing to do, and when a filter finds nothing", async () => {
    api.listReports.mockResolvedValue(page([]));
    render(<ReportsQueue communityId="c1" />);
    expect(await screen.findByText("Nothing to look at. No reports are waiting.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Show"), { target: { value: "dismissed" } });
    expect(await screen.findByText("No reports here.")).toBeTruthy();
    expect(api.listReports).toHaveBeenLastCalledWith("c1", { before: undefined, limit: 25, status: "dismissed" });
  });

  it("asks for everything with no status, and pages older ones in", async () => {
    api.listReports.mockResolvedValueOnce(page([report("r2")], 2)).mockResolvedValueOnce(page([report("r1")], null));
    render(<ReportsQueue communityId="c1" />);
    await screen.findByRole("listitem");

    fireEvent.click(screen.getByRole("button", { name: "Load older" }));
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
    expect(api.listReports).toHaveBeenLastCalledWith("c1", { before: 2, limit: 25, status: "open" });
    expect(screen.queryByRole("button", { name: "Load older" })).toBeNull();

    api.listReports.mockResolvedValue(page([report("r3")]));
    fireEvent.change(screen.getByLabelText("Show"), { target: { value: "all" } });
    await waitFor(() => expect(api.listReports).toHaveBeenLastCalledWith("c1", { before: undefined, limit: 25 }));
  });

  it("shows the answer to the newest question only, however late an older one arrives", async () => {
    let answerFirst: (p: ReportPage) => void = () => {};
    api.listReports.mockReturnValueOnce(new Promise((resolve) => (answerFirst = resolve))).mockResolvedValue(page([report("dismissed1", { status: "dismissed" })]));
    render(<ReportsQueue communityId="c1" />);

    fireEvent.change(screen.getByLabelText("Show"), { target: { value: "dismissed" } });
    await screen.findByRole("listitem");
    answerFirst(page([report("old-open")]));
    await new Promise((r) => setTimeout(r, 10));

    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByLabelText(/Spam: report about a message/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
  });

  it("says when it could not load", async () => {
    api.listReports.mockRejectedValue(new Error("down"));
    render(<ReportsQueue communityId="c1" />);
    expect(await screen.findByText("Couldn't load the reports. Try again.")).toBeTruthy();
  });
});

describe("closing and reopening", () => {
  it("resolves with what was done and a note, then the report leaves the list of open ones and the count drops", async () => {
    api.resolveReport.mockResolvedValue({ report: report("r1", { status: "resolved", resolution: { at: "2026-01-02T00:00:00.000Z", by: "@mod:chat.example", action: "message_deleted", note: "gone" } }) });
    api.listReports.mockResolvedValue(page([report("r1"), report("r2")]));
    render(<ReportsQueue communityId="c1" />);
    await screen.findAllByRole("listitem");

    fireEvent.click(within(card(0)).getByRole("button", { name: "Resolve" }));
    fireEvent.change(screen.getByLabelText("What was done?"), { target: { value: "message_deleted" } });
    fireEvent.change(screen.getByLabelText(/^Note/), { target: { value: "  gone  " } });
    fireEvent.click(screen.getByRole("button", { name: "Mark resolved" }));

    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
    expect(api.resolveReport).toHaveBeenCalledWith("c1", "r1", { action: "message_deleted", note: "gone" });
    expect(screen.getByText("1 open report")).toBeTruthy();
  });

  it("says that resolving only records what was done", async () => {
    render(<ReportsQueue communityId="c1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Resolve" }));
    expect(screen.getByText(/records what was done\. To delete the message or remove someone, do it first/)).toBeTruthy();
  });

  it("dismisses with or without a note and can back out", async () => {
    api.dismissReport.mockResolvedValue({ report: report("r1", { status: "dismissed", resolution: { at: null, by: "@mod:chat.example", action: null, note: null } }) });
    render(<ReportsQueue communityId={null} />);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Resolve" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss report" }));

    await waitFor(() => expect(screen.queryByRole("listitem")).toBeNull());
    expect(api.dismissReport).toHaveBeenCalledWith(null, "r1", {});
  });

  it("keeps a closed report in the list while showing everything, with how it was closed, and reopens it", async () => {
    const closed = report("r1", { status: "resolved", resolution: { at: "2026-01-02T00:00:00.000Z", by: "@mod:chat.example", action: "member_banned", note: "repeat offender" } });
    api.listReports.mockResolvedValue(page([closed], null, 0));
    api.reopenReport.mockResolvedValue({ report: report("r1") });
    render(<ReportsQueue communityId="c1" />);
    fireEvent.change(screen.getByLabelText("Show"), { target: { value: "all" } });
    const item = await screen.findByRole("listitem");

    expect(item.textContent).toContain("Resolved (member banned) by @mod:chat.example");
    expect(item.textContent).toContain("repeat offender");
    expect(within(item).queryByRole("button", { name: "Resolve" })).toBeNull();

    fireEvent.click(within(item).getByRole("button", { name: "Reopen" }));
    expect(await screen.findByRole("button", { name: "Resolve" })).toBeTruthy();
    expect(api.reopenReport).toHaveBeenCalledWith("c1", "r1");
    expect(screen.getByText("1 open report")).toBeTruthy();
  });

  it("does not carry a note written for one report into the next thing done with it", async () => {
    api.dismissReport.mockResolvedValue({ report: report("r1", { status: "dismissed", resolution: { at: null, by: "@mod:chat.example", action: null, note: "first note" } }) });
    api.reopenReport.mockResolvedValue({ report: report("r1") });
    render(<ReportsQueue communityId="c1" />);
    fireEvent.change(screen.getByLabelText("Show"), { target: { value: "all" } });
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    fireEvent.change(screen.getByLabelText(/^Note/), { target: { value: "first note" } });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss report" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reopen" }));

    fireEvent.click(await screen.findByRole("button", { name: "Resolve" }));
    expect((screen.getByLabelText(/^Note/) as HTMLTextAreaElement).value).toBe("");
  });

  it("tells a reviewer someone else got there first, and leaves the form for them to read", async () => {
    api.dismissReport.mockRejectedValue(new ApiError(409, { error: "not_open" }));
    render(<ReportsQueue communityId="c1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss report" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Someone else has already closed this report");
    expect(screen.getByRole("button", { name: "Dismiss report" })).toBeTruthy();
  });

  it("says a failure it cannot explain without losing the note that was written", async () => {
    api.resolveReport.mockRejectedValue(new Error("down"));
    render(<ReportsQueue communityId="c1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Resolve" }));
    fireEvent.change(screen.getByLabelText(/^Note/), { target: { value: "my careful note" } });
    fireEvent.click(screen.getByRole("button", { name: "Mark resolved" }));

    expect((await screen.findByRole("alert")).textContent).toContain("That didn't work");
    expect((screen.getByLabelText(/^Note/) as HTMLTextAreaElement).value).toBe("my careful note");
  });

  it("limits a note as the server does", async () => {
    render(<ReportsQueue communityId="c1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(screen.getByLabelText(/^Note/).getAttribute("maxlength")).toBe("500");
  });
});
