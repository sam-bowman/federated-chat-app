import { describe, expect, it } from "vitest";
import { cardsOf, cardsSummary } from "./richEmbeds";

const good = {
  title: "Dune",
  description: "A 2021 film.\nDirected by Denis Villeneuve.",
  url: "https://example.com/dune",
  color: "#AABBCC",
  fields: [{ name: "Year", value: "2021", inline: true }],
  footer: "via robo",
  image: { url: "https://chat.example/uploads/a.png", width: 640, height: 480 },
  thumbnail: { url: "https://chat.example/uploads/b.png", width: 64, height: 64 },
};

describe("cardsOf", () => {
  it("reads a good card as it is, with the colour in lower case and the address as the browser reads it", () => {
    expect(cardsOf([good], true)).toEqual([
      {
        title: "Dune",
        description: "A 2021 film.\nDirected by Denis Villeneuve.",
        href: "https://example.com/dune",
        colour: "#aabbcc",
        fields: [{ name: "Year", value: "2021", inline: true }],
        footer: "via robo",
        image: { src: "https://chat.example/uploads/a.png", width: 640, height: 480 },
        thumbnail: { src: "https://chat.example/uploads/b.png", width: 64, height: 64 },
      },
    ]);
  });

  it("is nothing for anything that is not a list, and ignores what is not a card", () => {
    for (const v of [undefined, null, "x", 5, {}, { title: "t" }]) expect(cardsOf(v, true), String(v)).toEqual([]);
    expect(cardsOf([null, "x", 5, [], { title: "Dune" }], true)).toHaveLength(1);
  });

  it("draws at most three cards", () => {
    expect(cardsOf([1, 2, 3, 4, 5].map((n) => ({ title: `Card ${n}` })), true)).toHaveLength(3);
  });

  it("leaves out a card with nothing to show: no title, description, field or picture", () => {
    expect(cardsOf([{ url: "https://example.com", color: "#112233", footer: "only a footer" }, { title: "   " }, { description: "" }], true)).toEqual([]);
  });

  it("keeps a title or description only when it is text", () => {
    const [card] = cardsOf([{ title: 5, description: ["a"], footer: {}, fields: "no", url: 5 }, { title: "Real" }], true);
    expect(card.title).toBe("Real");
  });

  it("keeps at most ten fields, each with a name and a value, and `inline` only when it is exactly true", () => {
    const fields = Array.from({ length: 14 }, (_, i) => ({ name: `Field ${i}`, value: "v", inline: i === 0 ? true : "yes" }));
    const [card] = cardsOf([{ title: "t", fields: [...fields, { name: "", value: "no name" }, { name: "no value", value: " " }, null, "x"] }], true);
    expect(card.fields).toHaveLength(10);
    expect(card.fields[0].inline).toBe(true);
    expect(card.fields.slice(1).every((f) => !f.inline)).toBe(true);
  });

  it("links the title only to a plain http(s) address with no name and password in it", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "ftp://example.com", "/relative", "https://user:pw@example.com", "nonsense", 5, null]) {
      expect(cardsOf([{ title: "t", url: bad }], true)[0].href, String(bad)).toBeNull();
    }
    expect(cardsOf([{ title: "t", url: "https://example.com/a?b=1" }], true)[0].href).toBe("https://example.com/a?b=1");
  });

  it("takes a colour only when it is exactly #rrggbb, since it reaches CSS", () => {
    for (const bad of ["red", "#abc", "#aabbccdd", "aabbcc", "#gggggg", "url(javascript:1)", "#aabbcc; background: red", 5, null]) {
      expect(cardsOf([{ title: "t", color: bad }], true)[0].colour, String(bad)).toBeNull();
    }
  });

  it("draws a picture only as a copy of a sane size at a plain http(s) address", () => {
    const pictured = (image: unknown) => cardsOf([{ title: "t", image }], true)[0].image;
    expect(pictured({ url: "https://chat.example/a.png", width: 10, height: 10 })).not.toBeNull();
    for (const bad of [{ url: "javascript:1", width: 10, height: 10 }, { url: "https://chat.example/a.png", width: 0, height: 10 }, { url: "https://chat.example/a.png", width: 10, height: 99999 }, { url: "https://chat.example/a.png" }, "https://chat.example/a.png", null]) {
      expect(pictured(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("draws no pictures while this device hides them, and a card that was only a picture goes with them", () => {
    const [card] = cardsOf([good], false);
    expect(card.image).toBeNull();
    expect(card.thumbnail).toBeNull();
    expect(card.title).toBe("Dune");
    expect(cardsOf([{ image: good.image }], false)).toEqual([]);
    expect(cardsOf([{ image: good.image }], true)).toHaveLength(1);
  });
});

describe("cardsSummary", () => {
  it("is the first card's title, else the first line of its description, else nothing", () => {
    expect(cardsSummary([{ title: "Dune" }, { title: "Other" }])).toBe("Dune");
    expect(cardsSummary([{ title: "Dune", description: "A film" }])).toBe("Dune");
    expect(cardsSummary([{ description: "First line\nSecond" }])).toBe("First line");
    expect(cardsSummary([{ fields: [{ name: "n", value: "v" }] }])).toBeNull();
    expect(cardsSummary(undefined)).toBeNull();
    expect(cardsSummary("nonsense")).toBeNull();
  });
});
