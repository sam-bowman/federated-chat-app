import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { getActiveChat, isAppFocused, setActiveChat, useReportActiveChat } from "./activeChat";
import type { Place } from "./notificationPrefs";

function Page({ place }: { place: Place | null }) {
  useReportActiveChat(place);
  return null;
}

afterEach(() => {
  cleanup();
  setActiveChat(null);
});

describe("useReportActiveChat", () => {
  it("says which conversation is open, and nothing once the page goes away", () => {
    const { unmount } = render(<Page place={{ conversationId: "c1" }} />);
    expect(getActiveChat()).toEqual({ conversationId: "c1" });
    unmount();
    expect(getActiveChat()).toBeNull();
  });

  it("follows the person from one channel to another", () => {
    const { rerender } = render(<Page place={{ channelId: "ch1", communityId: "co1" }} />);
    expect(getActiveChat()).toEqual({ channelId: "ch1", communityId: "co1" });
    rerender(<Page place={{ channelId: "ch2", communityId: "co1" }} />);
    expect(getActiveChat()).toEqual({ channelId: "ch2", communityId: "co1" });
  });

  it("says nothing is open for a page that is showing none", () => {
    setActiveChat({ conversationId: "stale" });
    render(<Page place={null} />);
    expect(getActiveChat()).toBeNull();
  });

  it("does not clear the place the NEXT page has already set when the old one goes away", () => {
    const first = render(<Page place={{ conversationId: "c1" }} />);
    const second = render(<Page place={{ conversationId: "c2" }} />);
    expect(getActiveChat()).toEqual({ conversationId: "c2" });
    first.unmount();
    expect(getActiveChat()).toEqual({ conversationId: "c2" });
    second.unmount();
    expect(getActiveChat()).toBeNull();
  });
});

describe("isAppFocused", () => {
  it("needs the page to be visible and to have focus", () => {
    const hasFocus = document.hasFocus;
    const visibility = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
    try {
      document.hasFocus = () => true;
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      expect(isAppFocused()).toBe(true);
      document.hasFocus = () => false;
      expect(isAppFocused()).toBe(false);
      document.hasFocus = () => true;
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      expect(isAppFocused()).toBe(false);
    } finally {
      document.hasFocus = hasFocus;
      delete (document as unknown as { visibilityState?: unknown }).visibilityState;
      if (visibility) Object.defineProperty(Document.prototype, "visibilityState", visibility);
    }
  });
});
