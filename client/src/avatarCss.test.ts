import { describe, expect, it } from "vitest";
import css from "./index.css?raw";

// jsdom does not compute styles, so the sizes and the layout are checked in the stylesheet's text.
const block = (selector: string) => {
  // At the start of a line, so `.avatar` is not found inside `.account-avatar .avatar`.
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `${selector} has a rule`).not.toBe(-1);
  return css.slice(start, css.indexOf("}", start));
};

describe("avatar sizes", () => {
  it("are defined once, in rem, as variables", () => {
    for (const name of ["--avatar-sm", "--avatar-md", "--avatar-xl"]) {
      expect(css).toMatch(new RegExp(`${name}:\\s*[\\d.]+rem;`));
    }
  });

  it("are the only place a size is set: each avatar rule points --avatar-size at one of them", () => {
    expect(block(".avatar")).toContain("--avatar-size: var(--avatar-md)");
    expect(block(".avatar.sm")).toContain("--avatar-size: var(--avatar-sm)");
    expect(block(".avatar.xl")).toContain("--avatar-size: var(--avatar-xl)");
  });

  it("size the circle and the letter from that one variable, and crop a picture to fit", () => {
    const avatar = block(".avatar");
    expect(avatar).toContain("width: var(--avatar-size)");
    expect(avatar).toContain("height: var(--avatar-size)");
    expect(avatar).toContain("font-size: calc(var(--avatar-size)");
    expect(avatar).toContain("object-fit: cover");
  });
});

describe("the identity under your name", () => {
  const identity = () => block(".account-identity");

  it("wraps instead of being cut off with an ellipsis, so the full username is always readable", () => {
    expect(identity()).toContain("overflow-wrap: anywhere");
    expect(identity()).not.toContain("text-overflow");
    expect(identity()).not.toContain("white-space: nowrap");
    expect(identity()).not.toContain("overflow: hidden");
  });
});

describe("the sidebar's width", () => {
  it("comes from --sidebar-width, with a default, and never takes more than 45% of a narrow window", () => {
    expect(block(".app-shell")).toContain("min(var(--sidebar-width, 20rem), 45vw)");
  });

  it("lets the page column shrink, so a wide page cannot push the window sideways", () => {
    expect(block(".app-shell")).toContain("minmax(0, 1fr)");
  });

  it("puts the resize handle over the grid, on the sidebar's edge, rather than in a column of its own", () => {
    const handle = block(".sidebar-resizer");
    expect(handle).toContain("position: absolute");
    expect(handle).toContain("min(var(--sidebar-width, 20rem), 45vw)");
    expect(handle).toContain("cursor: col-resize");
  });
});
