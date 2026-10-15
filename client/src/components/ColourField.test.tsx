import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ColourField from "./ColourField";

afterEach(cleanup);

/** Holds the value the way the role editor does. */
function Harness({ initial = null, onChange }: { initial?: string | null; onChange?: (c: string | null) => void }) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <ColourField
      label="Role colour"
      value={value}
      previewText="Moderator"
      onChange={(colour) => {
        setValue(colour);
        onChange?.(colour);
      }}
    />
  );
}

const swatch = (name: string) => screen.getByRole("button", { name });

describe("ColourField", () => {
  it("shows 'No colour' when there is none, and the hex when there is one", () => {
    const { unmount } = render(<Harness />);
    expect(swatch("Role colour: no colour. Change").textContent).toContain("No colour");
    unmount();

    render(<Harness initial="#ff8800" />);
    expect(swatch("Role colour: #ff8800. Change").textContent).toContain("#ff8800");
  });

  it("opens the picker as a dialog from the swatch, in the page body", () => {
    render(<Harness />);

    fireEvent.click(swatch("Role colour: no colour. Change"));

    const dialog = screen.getByRole("dialog", { name: "Choose a colour" });
    expect(dialog.closest("body")).toBe(document.body);
    expect(swatch("Role colour: no colour. Change").getAttribute("aria-haspopup")).toBe("dialog");
  });

  it("takes the applied colour, and shows it on the swatch", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    fireEvent.click(swatch("Role colour: no colour. Change"));
    fireEvent.click(screen.getByRole("radio", { name: "Teal (#1fb5a7)" }));
    expect(onChange).not.toHaveBeenCalled(); // nothing is decided until Apply
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(onChange).toHaveBeenCalledWith("#1fb5a7");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(swatch("Role colour: #1fb5a7. Change")).toBeTruthy();
  });

  it("leaves the colour as it was when the picker is cancelled or escaped", () => {
    const onChange = vi.fn();
    render(<Harness initial="#ff8800" onChange={onChange} />);

    fireEvent.click(swatch("Role colour: #ff8800. Change"));
    fireEvent.click(screen.getByRole("radio", { name: "Blue (#3b9cf5)" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(swatch("Role colour: #ff8800. Change"));
    fireEvent.click(screen.getByRole("radio", { name: "Blue (#3b9cf5)" }));
    fireEvent.keyDown(document, { key: "Escape" });

    expect(onChange).not.toHaveBeenCalled();
    expect(swatch("Role colour: #ff8800. Change")).toBeTruthy();
  });

  it("can take the colour away", () => {
    const onChange = vi.fn();
    render(<Harness initial="#ff8800" onChange={onChange} />);

    fireEvent.click(swatch("Role colour: #ff8800. Change"));
    fireEvent.click(screen.getByRole("radio", { name: "No colour" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(onChange).toHaveBeenCalledWith(null);
    expect(swatch("Role colour: no colour. Change")).toBeTruthy();
  });

  it("starts the picker from the current colour", () => {
    render(<Harness initial="#3bc47e" />);

    fireEvent.click(swatch("Role colour: #3bc47e. Change"));

    expect(screen.getByRole("radio", { name: "Green (#3bc47e)" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByLabelText("Hex")).toHaveProperty("value", "#3bc47e");
  });

  it("puts focus back on the swatch when the picker closes", () => {
    render(<Harness />);
    swatch("Role colour: no colour. Change").focus();

    fireEvent.click(swatch("Role colour: no colour. Change"));
    expect(document.activeElement && screen.getByRole("dialog").contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement).toBe(swatch("Role colour: no colour. Change"));
  });

  // The role editor is a form, and a React submit bubbles up the tree even through a portal: applying
  // a colour must not also create the role.
  it("does not submit a form it sits in when a colour is applied", () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Harness />
      </form>
    );

    fireEvent.click(swatch("Role colour: no colour. Change"));
    fireEvent.click(screen.getByRole("radio", { name: "Gold (#e8b84b)" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not turn the swatch itself into a submit button", () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Harness />
      </form>
    );

    fireEvent.click(swatch("Role colour: no colour. Change"));

    expect(onSubmit).not.toHaveBeenCalled();
  });
});
