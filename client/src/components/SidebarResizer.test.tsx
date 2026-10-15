import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SidebarResizer from "./SidebarResizer";

afterEach(cleanup);

function setup(width = 20) {
  const onChange = vi.fn();
  const onCommit = vi.fn();
  const onReset = vi.fn();
  render(
    <div data-testid="shell">
      <SidebarResizer width={width} onChange={onChange} onCommit={onCommit} onReset={onReset} />
    </div>
  );
  const handle = screen.getByRole("separator", { name: "Resize the sidebar" });
  return { handle, onChange, onCommit, onReset };
}

// jsdom has no layout: the shell starts at x = 0 and the root font is the 16px default, so a pointer at
// x pixels means (x / 16 - 4.5) rem, the 4.5rem being the community rail.
const px = (rem: number) => (rem + 4.5) * 16;

describe("the sidebar's resize handle", () => {
  it("is a vertical separator that says its width and range, and can be tabbed to", () => {
    const { handle } = setup(16.5);

    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-valuemin")).toBe("14");
    expect(handle.getAttribute("aria-valuemax")).toBe("32");
    expect(handle.getAttribute("aria-valuenow")).toBe("16.5");
    expect(handle.getAttribute("aria-valuetext")).toBe("16.5 rem wide");
    expect(handle.tabIndex).toBe(0);
  });

  it("says when it is at the default width", () => {
    const { handle } = setup(20);

    expect(handle.getAttribute("aria-valuetext")).toBe("20 rem wide (default)");
  });

  it("follows the pointer while dragging, and remembers the width once, when the pointer is released", () => {
    const { handle, onChange, onCommit } = setup();

    fireEvent.pointerDown(handle, { clientX: px(20), pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: px(24), pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: px(26.5), pointerId: 1 });

    expect(onChange).toHaveBeenLastCalledWith(26.5);
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.pointerUp(handle, { clientX: px(26.5), pointerId: 1 });

    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith(26.5);
  });

  it("never goes outside the allowed range, however far the pointer goes", () => {
    const { handle, onChange } = setup();

    fireEvent.pointerDown(handle, { clientX: px(20), pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 5000, pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith(32);
    fireEvent.pointerMove(handle, { clientX: 0, pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith(14);
  });

  it("ignores the pointer moving over it when it has not been pressed", () => {
    const { handle, onChange, onCommit } = setup();

    fireEvent.pointerMove(handle, { clientX: px(25), pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: px(25), pointerId: 1 });

    expect(onChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("remembers the current width, not an older one, when pressed and released without moving", () => {
    const { handle, onCommit } = setup(23);

    fireEvent.pointerDown(handle, { clientX: px(23), pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: px(23), pointerId: 1 });

    expect(onCommit).toHaveBeenCalledWith(23);
  });

  it("remembers the width a cancelled drag had reached, rather than leaving it half-saved", () => {
    const { handle, onCommit } = setup();

    fireEvent.pointerDown(handle, { clientX: px(20), pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: px(18), pointerId: 1 });
    fireEvent.pointerCancel(handle, { pointerId: 1 });

    expect(onCommit).toHaveBeenCalledWith(18);
  });

  it("moves a rem at a time with the arrow keys, and remembers each", () => {
    const { handle, onChange, onCommit } = setup(20);

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith(21);
    expect(onCommit).toHaveBeenLastCalledWith(21);

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith(19);
    expect(onCommit).toHaveBeenLastCalledWith(19);
  });

  it("goes to the narrowest with Home and the widest with End", () => {
    const { handle, onChange } = setup(20);

    fireEvent.keyDown(handle, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith(14);
    fireEvent.keyDown(handle, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith(32);
  });

  it("stops at the ends of the range with the arrow keys", () => {
    const narrow = setup(14);
    fireEvent.keyDown(narrow.handle, { key: "ArrowLeft" });
    expect(narrow.onChange).toHaveBeenLastCalledWith(14);
    cleanup();

    const wide = setup(32);
    fireEvent.keyDown(wide.handle, { key: "ArrowRight" });
    expect(wide.onChange).toHaveBeenLastCalledWith(32);
  });

  it("leaves other keys alone", () => {
    const { handle, onChange, onCommit } = setup();

    fireEvent.keyDown(handle, { key: "a" });
    fireEvent.keyDown(handle, { key: "Tab" });

    expect(onChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("goes back to the default on a double click", () => {
    const { handle, onReset } = setup(27);

    fireEvent.doubleClick(handle);

    expect(onReset).toHaveBeenCalledOnce();
  });
});
