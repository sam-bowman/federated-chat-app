import { describe, expect, it } from "vitest";
import css from "../index.css?raw";
import { contrastRatio } from "./contrast";

// The colours the shared button styles use, read from index.css itself so this fails when a
// token is changed to something unreadable. WCAG AA: 4.5:1 for normal-size text, and 3:1 for
// the parts of a control (such as the keyboard focus ring) that are not text. A disabled button
// is exempt from the requirement.
const root = css.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
const tokens = new Map([...root.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2]]));
const colour = (name: string) => {
  const value = tokens.get(name);
  if (!value) throw new Error(`--${name} is not a #rrggbb token in :root`);
  return value;
};

describe("button colours meet WCAG AA", () => {
  it("reads the tokens it checks", () => {
    expect(tokens.size).toBeGreaterThan(10);
  });

  // The button's text is white (.btn { color: #fff }); danger and primary share it.
  it.each([
    ["primary", "btn-primary"],
    ["primary hover", "btn-primary-hover"],
    ["danger", "btn-danger"],
    ["danger hover", "btn-danger-hover"],
  ])("white text on the %s fill is at least 4.5:1", (_name, token) => {
    expect(contrastRatio("#ffffff", colour(token))).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ["secondary", "bg-3"],
    ["secondary hover", "border"],
  ])("normal text on the %s fill is at least 4.5:1", (_name, token) => {
    expect(contrastRatio(colour("text"), colour(token))).toBeGreaterThanOrEqual(4.5);
  });

  // The link variant sits on the page, sidebar and panel backgrounds.
  it.each(["bg-0", "bg-1", "bg-2"])("link text is at least 4.5:1 on --%s", (token) => {
    expect(contrastRatio(colour("accent-hover"), colour(token))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(["bg-0", "bg-1", "bg-2", "bg-3"])("the focus ring is at least 3:1 on --%s", (token) => {
    expect(contrastRatio(colour("focus-ring"), colour(token))).toBeGreaterThanOrEqual(3);
  });

  // So the table above cannot drift away from what the stylesheet really uses.
  it.each(["btn-primary", "btn-primary-hover", "btn-danger", "btn-danger-hover", "focus-ring"])(
    "index.css really uses --%s",
    (token) => {
      expect(css).toContain(`var(--${token})`);
    }
  );
});
