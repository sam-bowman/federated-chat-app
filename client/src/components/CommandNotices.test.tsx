import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Notice } from "../lib/commandNotices";
import CommandNotices from "./CommandNotices";

// A card's picture address is made absolute against the home server, which a test has not resolved.
vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api")>()), mediaUrl: (path: string) => path }));

afterEach(cleanup);

const base = { channelId: "ch1", botName: "Robo", commandName: "request" };
const notices: Notice[] = [
  { ...base, interactionId: "a", kind: "waiting" },
  { ...base, interactionId: "b", kind: "thinking" },
  { ...base, interactionId: "c", kind: "failed" },
  { ...base, interactionId: "d", kind: "private", content: "Only you see this", richEmbeds: [{ title: "Dune" }] },
];

describe("CommandNotices", () => {
  it("draws nothing when there is nothing to say", () => {
    const { container } = render(<CommandNotices notices={[]} onDismiss={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("says what each command is doing, and a private reply with its text and cards", () => {
    render(<CommandNotices notices={notices} onDismiss={vi.fn()} />);
    expect(screen.getByRole("region", { name: "Replies to your commands" })).toBeTruthy();
    expect(screen.getByText("Waiting for Robo…")).toBeTruthy();
    expect(screen.getByText("Robo is thinking…")).toBeTruthy();
    expect(screen.getByText("Robo didn't respond to /request.")).toBeTruthy();
    expect(screen.getByText("Only you can see this · Robo · /request")).toBeTruthy();
    expect(screen.getByText("Only you see this")).toBeTruthy();
    expect(screen.getByRole("article", { name: "Card: Dune" })).toBeTruthy();
  });

  it("can dismiss a failure and a private reply, and nothing that is still going on", () => {
    const onDismiss = vi.fn();
    render(<CommandNotices notices={notices} onDismiss={onDismiss} />);
    const buttons = screen.getAllByRole("button", { name: "Dismiss the reply to /request" });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[1]);
    expect(onDismiss.mock.calls).toEqual([["c"], ["d"]]);
  });

  it("shows a private reply's words as text, never as markup", () => {
    render(<CommandNotices notices={[{ ...base, interactionId: "x", kind: "private", content: "<img src=x onerror=alert(1)>", richEmbeds: [] }]} onDismiss={vi.fn()} />);
    expect(document.querySelector(".command-notice-text")!.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(document.querySelector(".command-notices img")).toBeNull();
  });

  it("draws no empty text line for a private reply that is only cards", () => {
    render(<CommandNotices notices={[{ ...base, interactionId: "x", kind: "private", content: "", richEmbeds: [{ title: "Dune" }] }]} onDismiss={vi.fn()} />);
    expect(document.querySelector(".command-notice-text")).toBeNull();
  });
});
