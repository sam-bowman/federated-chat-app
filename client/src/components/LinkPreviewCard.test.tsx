import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Embed } from "../api";
import LinkPreviewCard from "./LinkPreviewCard";

afterEach(cleanup);

const embed = (over: Partial<Embed> = {}): Embed => ({
  url: "https://www.example.com/post",
  title: "A post",
  description: "What it says",
  siteName: "Example",
  ...over,
});

describe("LinkPreviewCard", () => {
  it("shows the title as a safe link, the description, and the site beside its real host", () => {
    render(<LinkPreviewCard embed={embed()} />);

    const link = screen.getByRole("link", { name: "A post" });
    expect(link.getAttribute("href")).toBe("https://www.example.com/post");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(screen.getByText("What it says")).toBeTruthy();
    expect(screen.getByText("Example · example.com")).toBeTruthy();
  });

  it("does not repeat the host when the site calls itself by it", () => {
    render(<LinkPreviewCard embed={embed({ siteName: "Example.com" })} />);
    expect(screen.getByText("example.com")).toBeTruthy();
  });

  it("shows a page's claim about itself as text, never as markup, next to where the link really goes", () => {
    render(<LinkPreviewCard embed={embed({ title: "<img src=x onerror=alert(1)>", siteName: "Your Bank", url: "https://evil.example/login" })} />);

    expect(screen.getByRole("link").textContent).toBe("<img src=x onerror=alert(1)>");
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("Your Bank · evil.example")).toBeTruthy();
  });

  it("draws nothing for an address that is not a plain web address, whoever sent it", () => {
    for (const url of ["javascript:alert(1)", "https://user:pw@example.com/", "nonsense"]) {
      const { container } = render(<LinkPreviewCard embed={embed({ url })} />);
      expect(container.firstChild, url).toBeNull();
      cleanup();
    }
  });

  it("draws nothing when there is neither a title nor a description", () => {
    const { container } = render(<LinkPreviewCard embed={embed({ title: null, description: null })} />);
    expect(container.firstChild).toBeNull();
  });

  it("copes with only a description", () => {
    render(<LinkPreviewCard embed={embed({ title: null })} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("What it says")).toBeTruthy();
  });

  it("offers a remove button only when it is given something to do", () => {
    const { rerender } = render(<LinkPreviewCard embed={embed()} />);
    expect(screen.queryByRole("button")).toBeNull();

    const onRemove = vi.fn();
    rerender(<LinkPreviewCard embed={embed()} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove the preview of example.com" }));
    expect(onRemove).toHaveBeenCalledOnce();
  });
});
