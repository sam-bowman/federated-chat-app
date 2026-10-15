import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import ChannelTopic from "./ChannelTopic";

afterEach(cleanup);

describe("ChannelTopic", () => {
  it.each([[null], [undefined], [""], ["   "]])("shows nothing for %j", (topic) => {
    const { container } = render(<ChannelTopic topic={topic} />);

    expect(container.firstChild).toBeNull();
  });

  it("shows the topic on one line, with the full text as its tooltip", () => {
    render(<ChannelTopic topic="  Release planning for 0.13  " />);

    const topic = screen.getByRole("button", { name: "Release planning for 0.13" });
    expect(topic.getAttribute("title")).toBe("Release planning for 0.13");
    expect(topic.className).not.toContain("expanded");
    expect(topic.getAttribute("aria-expanded")).toBe("false");
  });

  // A long topic is cut off with an ellipsis (CSS); clicking is how to read the rest in place.
  it("expands on click and collapses on the next", () => {
    render(<ChannelTopic topic={"x".repeat(256)} />);
    const topic = screen.getByRole("button");

    fireEvent.click(topic);
    expect(topic.className).toContain("expanded");
    expect(topic.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(topic);
    expect(topic.className).not.toContain("expanded");
  });

  // The topic is user-entered: it must reach the page as text, never as markup.
  it("shows markup as literal text", () => {
    const hostile = '<img src=x onerror="alert(1)"> <b>bold</b>';
    const { container } = render(<ChannelTopic topic={hostile} />);

    expect(screen.getByRole("button").textContent).toBe(hostile);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
  });
});
