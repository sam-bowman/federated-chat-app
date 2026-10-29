import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { MessageEmoticon } from "../api";
import MessageContent from "./MessageContent";

afterEach(cleanup);

const party: MessageEmoticon = {
  id: "E1",
  trigger: ":party:",
  imageUrl: "https://cdn.example/party.png",
  name: "Party",
  allowSave: false,
  creatorId: "u1",
};

function show(content: string, emoticons: MessageEmoticon[] = []) {
  return render(
    <div>
      <MessageContent content={content} emoticons={emoticons} currentUserId="me" />
    </div>
  );
}

describe("MessageContent: links", () => {
  it("makes an address a link that opens in a new tab and cannot reach back into the page", () => {
    show("read https://example.com/a?b=c#d now");
    const link = screen.getByRole("link", { name: "https://example.com/a?b=c#d" });

    expect(link.getAttribute("href")).toBe("https://example.com/a?b=c#d");
    expect(link.getAttribute("target")).toBe("_blank");
    const rel = (link.getAttribute("rel") ?? "").split(" ");
    expect(rel).toEqual(expect.arrayContaining(["noopener", "noreferrer", "nofollow"]));
  });

  it("keeps the rest of the message as text, in order, and leaves sentence punctuation out of the link", () => {
    const { container } = show("Look: https://example.com/page.");
    expect(container.textContent).toBe("Look: https://example.com/page.");
    expect(screen.getByRole("link").textContent).toBe("https://example.com/page");
  });

  it("shows what was typed for a www. address and goes to https", () => {
    show("www.example.com/x");
    const link = screen.getByRole("link");
    expect(link.textContent).toBe("www.example.com/x");
    expect(link.getAttribute("href")).toBe("https://www.example.com/x");
  });

  it("never makes a link of another scheme", () => {
    const { container } = show("javascript:alert(1) data:text/html,x file:///etc/passwd vbscript:x");
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("javascript:alert(1) data:text/html,x file:///etc/passwd vbscript:x");
  });

  it("does not turn markup in a message into elements", () => {
    const { container } = show('<a href="https://evil.example">x</a> <img src=x onerror=alert(1)> https://example.com/');
    // The only anchors are the ones we made, for the addresses that appear in the text; none is the one the message tried to inject.
    const anchors = Array.from(container.querySelectorAll("a"));
    expect(anchors.every((a) => a.classList.contains("message-link") && a.children.length === 0)).toBe(true);
    expect(anchors.map((a) => a.textContent)).toEqual(["https://evil.example", "https://example.com/"]);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain('<a href="https://evil.example">x</a>');
  });

  it("still shows emoticons around a link", () => {
    const { container } = show(":party: https://example.com/ :party:", [party]);
    expect(container.querySelectorAll("img")).toHaveLength(2);
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("does not take a trigger-shaped part of an address for an emoticon", () => {
    const { container } = show("https://example.com/a:party:b", [party]);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("link").textContent).toBe("https://example.com/a:party:b");
  });

  it("shows the same text with no links when there is none", () => {
    const { container } = show("just words :nothing:");
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("just words :nothing:");
  });
});

describe("MessageContent: emoji and emoticons (#285)", () => {
  const large = (container: HTMLElement) => container.querySelector(".message-jumbo");

  it("draws a message of only emoji large, and keeps every emoji", () => {
    const { container } = show("😀 🎉👍🏽");
    expect(large(container)).not.toBeNull();
    expect(Array.from(container.querySelectorAll(".emoji")).map((e) => e.textContent)).toEqual(["😀", "🎉", "👍🏽"]);
    expect(container.textContent).toBe("😀 🎉👍🏽");
  });

  it("draws a message of only a custom emoticon, or an emoticon and an emoji, large", () => {
    expect(large(show(":party:", [party]).container)).not.toBeNull();
    cleanup();
    expect(large(show(":party: 😀 :party:", [party]).container)).not.toBeNull();
  });

  it("does not draw a message large when it has words, a link, or any other text", () => {
    for (const text of ["hello 😀", "😀 ok", "😀!", "😀 https://example.com", "1 😀", "😀 :nothing:"]) {
      const { container } = show(text, [party]);
      expect(large(container), text).toBeNull();
      cleanup();
    }
  });

  it("treats a trigger that is not an emoticon here as text, so the message is not large", () => {
    expect(large(show(":party:").container)).toBeNull();
  });

  it("stops at ten: a wall of emoji is not a large message, and ten still is", () => {
    expect(large(show("😀".repeat(10)).container)).not.toBeNull();
    cleanup();
    expect(large(show("😀".repeat(11)).container)).toBeNull();
  });

  it("still marks the emoji in a sentence, so they can be drawn a little larger, and wraps nothing else", () => {
    const { container } = show("well played 😀 again");
    expect(container.querySelectorAll(".emoji").length).toBe(1);
    expect(container.querySelector(".message-jumbo")).toBeNull();
    expect(container.textContent).toBe("well played 😀 again");
  });

  it("has no wrapper at all for a plain message, and an empty one is not large", () => {
    const { container } = show("just words");
    expect(container.firstElementChild?.children.length).toBe(1);
    cleanup();
    expect(large(show("").container)).toBeNull();
  });

  it("gives an emoticon its size from a class, not from the element, so Settings can change it", () => {
    const { container } = show("hi :party:", [party]);
    const image = container.querySelector("img.emoticon-image") as HTMLImageElement;
    expect(image).not.toBeNull();
    expect(image.style.height).toBe("");
  });
});
