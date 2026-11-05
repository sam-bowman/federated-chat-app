import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import RichEmbedCard from "./RichEmbedCard";
import type { Card } from "../lib/richEmbeds";

afterEach(cleanup);

const card = (over: Partial<Card> = {}): Card => ({ title: "Dune", description: null, href: null, colour: null, fields: [], footer: null, image: null, thumbnail: null, ...over });
const picture = { src: "https://chat.example/uploads/a.png", width: 640, height: 480 };

describe("RichEmbedCard", () => {
  it("draws the title, description, fields and footer as text, in a card named for its title", () => {
    render(
      <RichEmbedCard
        card={card({ description: "A film.\nA good one.", fields: [{ name: "Year", value: "2021", inline: false }, { name: "Rating", value: "8.0", inline: true }], footer: "via robo" })}
      />
    );
    const article = screen.getByRole("article", { name: "Card: Dune" });
    expect(article.textContent).toContain("Dune");
    expect(article.textContent).toContain("A film.\nA good one.");
    expect(article.textContent).toContain("via robo");
    const fields = Array.from(article.querySelectorAll(".rich-card-field"));
    expect(fields.map((f) => f.querySelector("dt")!.textContent)).toEqual(["Year", "Rating"]);
    expect(fields[0].classList.contains("rich-card-field-inline")).toBe(false);
    expect(fields[1].classList.contains("rich-card-field-inline")).toBe(true);
  });

  it("makes the title a link only when it has an address, opening it safely in a new tab", () => {
    const { rerender } = render(<RichEmbedCard card={card({ href: "https://example.com/dune" })} />);
    const link = screen.getByRole("link", { name: "Dune" });
    expect(link.getAttribute("href")).toBe("https://example.com/dune");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    rerender(<RichEmbedCard card={card({ href: null })} />);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("draws markup in its text as text: nothing in it becomes an element", () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script> **bold** [a link](https://evil.example)';
    const { container } = render(<RichEmbedCard card={card({ title: hostile, description: hostile, footer: hostile, fields: [{ name: hostile, value: hostile, inline: false }] })} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("**bold**");
    expect(container.textContent).toContain("<script>alert(2)</script>");
  });

  it("puts the stripe colour in a custom property and nowhere else", () => {
    const { rerender } = render(<RichEmbedCard card={card({ colour: "#aabbcc" })} />);
    const article = screen.getByRole("article");
    expect(article.style.getPropertyValue("--card-stripe")).toBe("#aabbcc");
    expect(article.getAttribute("style")).not.toContain("background");
    rerender(<RichEmbedCard card={card({ colour: null })} />);
    expect(screen.getByRole("article").style.getPropertyValue("--card-stripe")).toBe("");
  });

  it("draws its pictures from the copy's address, without a referrer, and only the ones it has", () => {
    const { container, rerender } = render(<RichEmbedCard card={card({ image: picture, thumbnail: { ...picture, src: "https://chat.example/uploads/t.png", width: 64, height: 64 } })} />);
    const images = Array.from(container.querySelectorAll("img"));
    expect(images.map((i) => i.getAttribute("src"))).toEqual(["https://chat.example/uploads/a.png", "https://chat.example/uploads/t.png"]);
    expect(images.every((i) => i.getAttribute("referrerpolicy") === "no-referrer")).toBe(true);
    expect(images[0].getAttribute("width")).toBe("640");
    expect(images[0].getAttribute("alt")).toBe("Dune");
    rerender(<RichEmbedCard card={card()} />);
    expect(container.querySelector("img")).toBeNull();
  });

  it("is called just a card when it has no title", () => {
    render(<RichEmbedCard card={card({ title: null, description: "Only words" })} />);
    expect(screen.getByRole("article", { name: "Card" })).toBeTruthy();
  });
});
