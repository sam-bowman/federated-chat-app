import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import BotBadge from "./BotBadge";
import ProfileCard from "./ProfileCard";

afterEach(cleanup);

describe("the Bot badge", () => {
  it("marks a bot and nobody else", () => {
    const { container, rerender } = render(<BotBadge user={{ isBot: true }} />);
    expect(screen.getByText("Bot")).toBeTruthy();
    rerender(<BotBadge user={{ isBot: false }} />);
    expect(container.firstChild).toBeNull();
    // A server that predates bots does not say, which means a person.
    rerender(<BotBadge user={{}} />);
    expect(container.firstChild).toBeNull();
  });

  it("is on a bot's profile card", () => {
    const presence = { status: "ONLINE" as const, customStatus: null, lastSeenAt: null };
    const base = { identity: "@helper:chat.example", displayName: "Helper", avatarUrl: null, bio: null, presence };
    const { rerender } = render(<ProfileCard user={{ ...base, isBot: true }} />);
    expect(screen.getByText("Bot")).toBeTruthy();
    rerender(<ProfileCard user={base} />);
    expect(screen.queryByText("Bot")).toBeNull();
  });
});
