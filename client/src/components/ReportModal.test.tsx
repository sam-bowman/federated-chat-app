import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import ReportModal from "./ReportModal";

const api = vi.hoisted(() => ({ reportContent: vi.fn() }));
vi.mock("../api", () => ({ reportContent: api.reportContent }));

beforeEach(() => api.reportContent.mockReset().mockResolvedValue({ received: true }));
afterEach(cleanup);

const send = () => screen.getByRole("button", { name: "Send report" }) as HTMLButtonElement;
const choose = (name: string) => fireEvent.click(screen.getByRole("radio", { name: new RegExp(name) }));

describe("reporting", () => {
  it("cannot be sent until a reason is chosen", () => {
    render(<ReportModal kind="message" id="m1" name="Kim's message" onClose={() => {}} />);
    expect(send().disabled).toBe(true);
    choose("Spam");
    expect(send().disabled).toBe(false);
  });

  it("offers every reason as a choice of one", () => {
    render(<ReportModal kind="user" id="u1" name="Kim" onClose={() => {}} />);
    expect(screen.getAllByRole("radio").map((r) => (r as HTMLInputElement).value)).toEqual([
      "spam", "harassment", "hate", "illegal", "sexual", "impersonation", "other",
    ]);
  });

  it("sends what was reported, why, and the person's own words trimmed, and then only says it was sent", async () => {
    const onClose = vi.fn();
    render(<ReportModal kind="message" id="m1" name="Kim's message" onClose={onClose} />);

    choose("Harassment");
    fireEvent.change(screen.getByLabelText(/Anything a moderator should know/), { target: { value: "  keeps doing it  " } });
    fireEvent.click(send());

    await screen.findByRole("dialog", { name: "Report sent" });
    expect(api.reportContent).toHaveBeenCalledWith({ kind: "message", id: "m1", reason: "harassment", details: "keeps doing it" });
    expect(screen.getByText(/Your report about Kim's message was sent/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("sends no details when none were written", async () => {
    render(<ReportModal kind="community" id="c1" name="Club" onClose={() => {}} />);
    choose("Illegal");
    fireEvent.click(send());
    await screen.findByRole("dialog", { name: "Report sent" });
    expect(api.reportContent).toHaveBeenCalledWith({ kind: "community", id: "c1", reason: "illegal" });
  });

  it("says honestly who will see it, and that the person reported is not told", () => {
    const { unmount } = render(<ReportModal kind="message" id="m1" name="Kim's message" onClose={() => {}} />);
    expect(screen.getByText(/moderator of the community, or the server's admins/)).toBeTruthy();
    expect(screen.getByText(/They can see who reported it/)).toBeTruthy();
    expect(screen.getByText(/The person who wrote it is not told/)).toBeTruthy();
    unmount();
    render(<ReportModal kind="user" id="u1" name="Kim" onClose={() => {}} />);
    expect(screen.getByText(/The server's admins will look at it/)).toBeTruthy();
    expect(screen.queryByText(/moderator of the community/)).toBeNull();
  });

  it("stays open with the reason when it fails, and says why in words", async () => {
    api.reportContent.mockRejectedValue(new ApiError(409, { error: "remote_community" }));
    render(<ReportModal kind="message" id="m1" name="Kim's message" domain="far.example" onClose={() => {}} />);
    choose("Spam");
    fireEvent.click(send());

    expect((await screen.findByRole("alert")).textContent).toContain("another server (far.example)");
    expect(screen.getByRole("dialog", { name: "Report a message" })).toBeTruthy();
    expect((screen.getByRole("radio", { name: /Spam/ }) as HTMLInputElement).checked).toBe(true);
    // And it can be tried again once the reason for the failure has gone.
    api.reportContent.mockResolvedValue({ received: true });
    fireEvent.click(send());
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Report sent" })).toBeTruthy());
  });

  it("does not send twice while the first is on its way", async () => {
    let finish: () => void = () => {};
    api.reportContent.mockReturnValue(new Promise((resolve) => (finish = () => resolve({ received: true }))));
    render(<ReportModal kind="user" id="u1" name="Kim" onClose={() => {}} />);
    choose("Spam");
    fireEvent.click(send());
    fireEvent.click(send());
    expect(api.reportContent).toHaveBeenCalledTimes(1);
    finish();
    await screen.findByRole("dialog", { name: "Report sent" });
  });

  it("limits the words a person can add, as the server does", () => {
    render(<ReportModal kind="user" id="u1" name="Kim" onClose={() => {}} />);
    expect(screen.getByLabelText(/Anything a moderator should know/).getAttribute("maxlength")).toBe("500");
  });
});
