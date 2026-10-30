import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportContext as Context } from "../api";
import { ApiError } from "../api/client";
import ReportContext from "./ReportContext";

const api = vi.hoisted(() => ({ getReportContext: vi.fn() }));
vi.mock("../api", () => api);

const message = (id: string, text: string | null, over: Partial<Context["messages"][number]> = {}): Context["messages"][number] => ({
  id,
  sender: { identity: "@bob:chat.example", displayName: "Bob" },
  text,
  attachmentCount: 0,
  at: "2026-01-01T12:00:00.000Z",
  reported: false,
  ...over,
});
const context = (over: Partial<Context> = {}): { context: Context } => ({
  context: { state: "same", channel: "general", messages: [message("m1", "before"), message("m2", "the reported one", { reported: true }), message("m3", "after")], ...over },
});

beforeEach(() => {
  api.getReportContext.mockReset().mockResolvedValue(context());
});
afterEach(cleanup);

const show = () => render(<ReportContext communityId="c1" reportId="r1" />);
const open = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Show the messages around it" }));
  return screen.findByRole("list", { name: /Messages around the reported one/ });
};

describe("the messages around a reported one", () => {
  it("asks for nothing until the reviewer opens it", () => {
    show();
    expect(screen.getByRole("button", { name: "Show the messages around it" })).toBeTruthy();
    expect(api.getReportContext).not.toHaveBeenCalled();
  });

  it("shows them in order, names the channel, and marks the reported one", async () => {
    show();
    const list = await open();

    expect(api.getReportContext).toHaveBeenCalledWith("c1", "r1");
    expect(list.getAttribute("aria-label")).toBe("Messages around the reported one in # general");
    const items = within(list).getAllByRole("listitem");
    expect(items.map((li) => li.querySelector(".report-context-text")?.textContent)).toEqual(["before", "the reported one", "after"]);
    expect(items[1].getAttribute("aria-current")).toBe("true");
    expect(items[1].textContent).toContain("the reported message");
    expect(items[0].getAttribute("aria-current")).toBeNull();
    expect(items[0].textContent).toContain("Bob (@bob:chat.example)");
  });

  it("draws what strangers wrote as text, never as markup", async () => {
    const hostile = '<img src=x onerror=alert(1)> <a href="http://evil.example">click</a>';
    api.getReportContext.mockResolvedValue(context({ messages: [message("m1", hostile, { reported: true })] }));
    show();
    const list = await open();

    expect(list.querySelector("img, a")).toBeNull();
    expect(list.textContent).toContain(hostile);
  });

  it.each([
    ["edited", /edited after it was reported/],
    ["deleted", /deleted since it was reported/],
    ["gone", /no longer there/],
  ] as const)("says when the message was %s since", async (state, words) => {
    api.getReportContext.mockResolvedValue(context({ state }));
    show();
    fireEvent.click(screen.getByRole("button", { name: "Show the messages around it" }));
    expect(await screen.findByText(words)).toBeTruthy();
  });

  it("says nothing extra when it reads as it did", async () => {
    show();
    await open();
    expect(document.querySelector(".hint")).toBeNull();
  });

  it("shows nothing but the note when the message is gone", async () => {
    api.getReportContext.mockResolvedValue(context({ state: "gone", channel: null, messages: [] }));
    show();
    fireEvent.click(screen.getByRole("button", { name: "Show the messages around it" }));
    await screen.findByText(/no longer there/);
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("shows a deleted message as deleted, and counts attachments without showing them", async () => {
    api.getReportContext.mockResolvedValue(
      context({ messages: [message("m1", null), message("m2", "look", { attachmentCount: 2, reported: true }), message("m3", "", { attachmentCount: 1 })] })
    );
    show();
    const items = within(await open()).getAllByRole("listitem");

    expect(items[0].textContent).toContain("Deleted");
    expect(items[1].textContent).toContain("2 attachments");
    expect(items[2].textContent).toMatch(/1 attachment(?!s)/);
    expect(items[2].textContent).not.toContain("No text");
  });

  it("says when a message had no text and no attachment", async () => {
    api.getReportContext.mockResolvedValue(context({ messages: [message("m1", "", { reported: true })] }));
    show();
    expect(within(await open()).getByText("No text")).toBeTruthy();
  });

  it("says so when it cannot load, and can be tried again", async () => {
    api.getReportContext.mockRejectedValueOnce(new ApiError(500, null));
    show();
    fireEvent.click(screen.getByRole("button", { name: "Show the messages around it" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't load the messages around it");

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByRole("list", { name: /Messages around/ });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(api.getReportContext).toHaveBeenCalledTimes(2);
  });

  it("says it is loading while it waits", async () => {
    api.getReportContext.mockReturnValue(new Promise(() => undefined));
    show();
    fireEvent.click(screen.getByRole("button", { name: "Show the messages around it" }));

    expect(await screen.findByText("Loading…")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("takes the old messages off the screen when asking again fails, rather than showing them as if they were current", async () => {
    show();
    await open();
    api.getReportContext.mockRejectedValueOnce(new ApiError(500, null));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't load");
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("asks again each time it is opened, so it is never older than the click", async () => {
    show();
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Hide the messages around it" }));
    expect(screen.queryByRole("list")).toBeNull();

    api.getReportContext.mockResolvedValue(context({ messages: [message("m9", "newer", { reported: true })] }));
    fireEvent.click(screen.getByRole("button", { name: "Show the messages around it" }));
    await waitFor(() => expect(screen.getByText("newer")).toBeTruthy());
    expect(api.getReportContext).toHaveBeenCalledTimes(2);
  });
});
