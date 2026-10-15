import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Modal from "./Modal";

afterEach(cleanup);

describe("Modal: what is exposed", () => {
  it("is a modal dialog named by its title", () => {
    render(
      <Modal title="Community settings" onClose={vi.fn()}>
        body
      </Modal>
    );

    const dialog = screen.getByRole("dialog", { name: "Community settings" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  it("has a close button with its own name", () => {
    const onClose = vi.fn();
    render(
      <Modal title="T" onClose={onClose}>
        body
      </Modal>
    );

    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));

    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("Modal: closing", () => {
  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <Modal title="T" onClose={onClose}>
        body
      </Modal>
    );

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on a click on the backdrop, but not on a click inside the dialog", () => {
    const onClose = vi.fn();
    render(
      <Modal title="T" onClose={onClose}>
        <p>inside</p>
      </Modal>
    );

    fireEvent.click(screen.getByText("inside"));
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("dialog").parentElement!);
    expect(onClose).toHaveBeenCalledOnce();
  });

  // The colour picker over the role editor, a confirmation over the settings: Escape must not
  // take both down at once.
  it("closes only the topmost of stacked modals on Escape", () => {
    const closeOuter = vi.fn();
    const closeInner = vi.fn();
    render(
      <Modal title="Outer" onClose={closeOuter}>
        <Modal title="Inner" onClose={closeInner}>
          body
        </Modal>
      </Modal>
    );

    fireEvent.keyDown(document, { key: "Escape" });

    expect(closeInner).toHaveBeenCalledOnce();
    expect(closeOuter).not.toHaveBeenCalled();
  });

  it("gives Escape back to the outer modal once the inner one is gone", () => {
    const closeOuter = vi.fn();
    function Stack() {
      const [inner, setInner] = useState(true);
      return (
        <Modal title="Outer" onClose={closeOuter}>
          {inner && (
            <Modal title="Inner" onClose={() => setInner(false)}>
              body
            </Modal>
          )}
        </Modal>
      );
    }
    render(<Stack />);

    fireEvent.keyDown(document, { key: "Escape" }); // closes the inner one
    expect(screen.queryByRole("dialog", { name: "Inner" })).toBeNull();
    expect(closeOuter).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(closeOuter).toHaveBeenCalledOnce();
  });

  it("stops listening for Escape once it has closed", () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <Modal title="T" onClose={onClose}>
        body
      </Modal>
    );
    unmount();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls the latest onClose, not the one from when it opened", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(
      <Modal title="T" onClose={first}>
        body
      </Modal>
    );
    rerender(
      <Modal title="T" onClose={second}>
        body
      </Modal>
    );

    fireEvent.keyDown(document, { key: "Escape" });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });
});

describe("Modal: focus", () => {
  function Opener() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open it</button>
        {open && (
          <Modal title="T" onClose={() => setOpen(false)}>
            <input aria-label="first field" />
            <button>last button</button>
          </Modal>
        )}
      </>
    );
  }

  it("moves focus into the dialog when it opens, and back to the opener when it closes", () => {
    render(<Opener />);
    const opener = screen.getByRole("button", { name: "Open it" });
    opener.focus();

    fireEvent.click(opener);
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("leaves focus where an autoFocus field already put it", () => {
    render(
      <Modal title="T" onClose={vi.fn()}>
        <input aria-label="skip me" />
        <input aria-label="wanted" autoFocus />
      </Modal>
    );

    expect(document.activeElement).toBe(screen.getByLabelText("wanted"));
  });

  it("keeps Tab inside the dialog, wrapping from the last control to the first and back", () => {
    render(
      <>
        <button>outside before</button>
        <Modal title="T" onClose={vi.fn()}>
          <input aria-label="first field" />
          <button>last button</button>
        </Modal>
        <button>outside after</button>
      </>
    );
    const closeButton = screen.getByRole("button", { name: "Close dialog" });
    const last = screen.getByRole("button", { name: "last button" });

    last.focus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(closeButton); // the first control in the dialog

    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("does not trap Tab for a modal that is underneath another", () => {
    render(
      <Modal title="Outer" onClose={vi.fn()}>
        <button>outer button</button>
        <Modal title="Inner" onClose={vi.fn()}>
          <button>inner button</button>
        </Modal>
      </Modal>
    );
    const inner = screen.getByRole("button", { name: "inner button" });
    const innerClose = screen.getAllByRole("button", { name: "Close dialog" })[1];

    inner.focus();
    fireEvent.keyDown(inner, { key: "Tab" });

    // Wrapped by the inner modal's trap only (to its first control), not also moved by the outer one.
    expect(document.activeElement).toBe(innerClose);
  });
});
