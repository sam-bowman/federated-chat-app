import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { announceDeletionCancelled, dismissDeletionCancelled } from "../lib/deletionNotice";
import DeletionCancelledNotice from "./DeletionCancelledNotice";

afterEach(() => {
  cleanup();
  dismissDeletionCancelled();
});

describe("DeletionCancelledNotice", () => {
  it("shows nothing until a sign-in has cancelled a deletion", () => {
    const { container } = render(<DeletionCancelledNotice />);
    expect(container.firstChild).toBeNull();
  });

  it("then says so, and goes when the person has read it", () => {
    render(<DeletionCancelledNotice />);
    act(() => announceDeletionCancelled());
    expect(screen.getByRole("status").textContent).toContain("Signing in cancelled that");
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("is there when it is mounted after the sign-in, which is the usual order", () => {
    announceDeletionCancelled();
    render(<DeletionCancelledNotice />);
    expect(screen.getByRole("status")).toBeTruthy();
  });
});
