import { describe, expect, it } from "vitest";
import css from "./index.css?raw";

// jsdom computes no layout, so whether a dialog scrolls cannot be seen by rendering it; the real-browser check is the e2e
// test `small-screens.spec.ts`. This pins the rules it depends on, which are easy to lose in a stylesheet edit (#194):
// a dialog taller than the window used to be centred and clipped at the top and the bottom with nothing to scroll.
function block(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `${selector} is missing`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("}", start));
}

describe("dialogs on a small window", () => {
  it("are never taller than the window, and clip so that only the body scrolls", () => {
    const dialog = block(".modal-dialog");
    expect(dialog).toMatch(/max-height: calc\(100vh - 2rem\)/);
    // The dynamic viewport unit, so a phone's collapsing address bar does not hide the bottom of the dialog.
    expect(dialog).toMatch(/max-height: calc\(100dvh - 2rem\)/);
    expect(dialog).toMatch(/overflow: hidden/);
  });

  it("scroll their body, and let it shrink below its content (min-height: 0, or a flex child never scrolls)", () => {
    const body = block(".modal-body");
    expect(body).toMatch(/overflow: auto/);
    expect(body).toMatch(/min-height: 0/);
    expect(body).toMatch(/flex: 1 1 auto/);
  });

  it("keep the .modal-dialog rule after the .auth-card one it overrides (same specificity: the later wins)", () => {
    expect(css.indexOf("\n.modal-dialog {")).toBeGreaterThan(css.indexOf("\n.auth-card {"));
  });

  it("use only rem, vw and the viewport units (nothing in px, which would not follow the UI scale)", () => {
    expect(block(".modal-dialog")).not.toMatch(/\d+px/);
    expect(block(".modal-body")).not.toMatch(/\d+px/);
  });
});

describe("the sign-in card on a short window", () => {
  it("is centred with auto margins, not align-items, so a card taller than the window starts at the top", () => {
    const page = block(".auth-page");
    expect(page).toMatch(/min-height: 100vh/);
    expect(page).not.toMatch(/align-items: center/);
    expect(block(".auth-card")).toMatch(/margin: auto/);
  });
});
