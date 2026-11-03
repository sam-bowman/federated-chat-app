import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Embed } from "../api";
import LinkPreviewCard from "./LinkPreviewCard";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const embed = (over: Partial<Embed> = {}): Embed => ({
  url: "https://www.example.com/post",
  title: "A post",
  description: "What it says",
  siteName: "Example",
  ...over,
});

const picture = { url: "https://chat.example/uploads/abc.png", width: 1200, height: 630 };

describe("LinkPreviewCard with a picture (#244)", () => {
  it("draws the copy the server kept, with its shape, no referrer, lazily, and a click on it goes to the page", () => {
    const { container } = render(<LinkPreviewCard embed={embed({ image: picture })} />);

    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("https://chat.example/uploads/abc.png");
    expect(img.getAttribute("width")).toBe("1200");
    expect(img.getAttribute("height")).toBe("630");
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("alt")).toBe("A post");
    const around = img.closest("a")!;
    expect(around.getAttribute("href")).toBe("https://www.example.com/post");
    expect(around.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(around.getAttribute("target")).toBe("_blank");
  });

  it("is the whole card for a link that is itself a picture, with the host it is on", () => {
    render(<LinkPreviewCard embed={embed({ title: null, description: null, siteName: null, url: "https://img.example.org/cat.png", image: picture })} />);
    expect(screen.getByText("img.example.org")).toBeTruthy();
    expect(document.querySelector("img")).not.toBeNull();
    expect(document.querySelector(".link-preview-title")).toBeNull();
  });

  it("draws no picture, and keeps the card, when the address or the size is not something it will draw", () => {
    for (const bad of [
      { ...picture, url: "javascript:alert(1)" },
      { ...picture, url: "data:image/png;base64,AAAA" },
      { ...picture, url: "https://user:pw@chat.example/a.png" },
      { ...picture, url: "/uploads/relative.png" },
      { ...picture, width: 0 },
      { ...picture, height: -1 },
      { ...picture, width: 1.5 },
      { ...picture, width: 99999 },
      { ...picture, width: "1200" as unknown as number },
      "https://chat.example/a.png" as unknown as typeof picture,
      null as unknown as typeof picture,
    ]) {
      const { container } = render(<LinkPreviewCard embed={embed({ image: bad })} />);
      expect(container.querySelector("img"), JSON.stringify(bad)).toBeNull();
      expect(screen.getByRole("link", { name: "A post" }), JSON.stringify(bad)).toBeTruthy();
      cleanup();
    }
  });

  it("draws nothing for a link that is only a picture when the picture cannot be drawn", () => {
    const { container } = render(<LinkPreviewCard embed={embed({ title: null, description: null, image: { ...picture, url: "javascript:alert(1)" } })} />);
    expect(container.firstChild).toBeNull();
  });

  it("is left out when the person turned pictures off on this device: the text card stays, a card that was only a picture goes", () => {
    localStorage.setItem("chat.linkPreviewPictures", "hide");
    const { container } = render(<LinkPreviewCard embed={embed({ image: picture })} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("link", { name: "A post" })).toBeTruthy();
    cleanup();

    const only = render(<LinkPreviewCard embed={embed({ title: null, description: null, image: picture })} />);
    expect(only.container.firstChild).toBeNull();
  });

  it("describes the picture with the title if there is one, and the host if not, and never with markup", () => {
    render(<LinkPreviewCard embed={embed({ title: "<b>x</b>", image: picture })} />);
    expect(document.querySelector("img")!.getAttribute("alt")).toBe("<b>x</b>");
    expect(document.querySelector("b")).toBeNull();
    cleanup();
    render(<LinkPreviewCard embed={embed({ title: null, description: "d", image: picture })} />);
    expect(document.querySelector("img")!.getAttribute("alt")).toBe("example.com");
  });
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
