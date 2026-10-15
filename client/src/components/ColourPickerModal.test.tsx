import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ColourPickerModal from "./ColourPickerModal";

afterEach(cleanup);

function open(props: Partial<React.ComponentProps<typeof ColourPickerModal>> = {}) {
  const onApply = vi.fn();
  const onClose = vi.fn();
  render(<ColourPickerModal value={null} onApply={onApply} onClose={onClose} previewText="Moderator" {...props} />);
  return { onApply, onClose };
}

const hex = () => screen.getByLabelText("Hex") as HTMLInputElement;
const apply = () => screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement;
const slider = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
const radio = (name: string) => screen.getByRole("radio", { name });

describe("ColourPickerModal: the presets", () => {
  it("is a dialog with a radio group of presets, 'No colour' first", () => {
    open();

    expect(screen.getByRole("dialog", { name: "Choose a colour" })).toBeTruthy();
    const group = screen.getByRole("radiogroup", { name: "Preset colours" });
    const names = within(group).getAllByRole("radio").map((r) => r.getAttribute("aria-label"));
    expect(names[0]).toBe("No colour");
    expect(names).toHaveLength(13);
    expect(names).toContain("Indigo (#6c7cff)");
  });

  it("leaves out 'No colour' when the colour is required", () => {
    open({ allowNone: false });

    expect(screen.queryByRole("radio", { name: "No colour" })).toBeNull();
    expect(screen.getAllByRole("radio")).toHaveLength(12);
  });

  it("checks 'No colour' when there is no colour yet", () => {
    open();

    expect(radio("No colour").getAttribute("aria-checked")).toBe("true");
  });

  it("checks the preset that matches the starting colour, and shows it in the hex field", () => {
    open({ value: "#3bc47e" });

    expect(radio("Green (#3bc47e)").getAttribute("aria-checked")).toBe("true");
    expect(radio("No colour").getAttribute("aria-checked")).toBe("false");
    expect(hex().value).toBe("#3bc47e");
  });

  it("checks no preset for a custom colour, but keeps one in the tab order", () => {
    open({ value: "#123456" });

    expect(screen.getAllByRole("radio").every((r) => r.getAttribute("aria-checked") === "false")).toBe(true);
    expect(screen.getAllByRole("radio").map((r) => r.tabIndex)).toEqual([0, ...Array(12).fill(-1)]);
  });

  it("choosing a preset selects it and fills the hex field and the preview", () => {
    open();

    fireEvent.click(radio("Orange (#f08a3c)"));

    expect(radio("Orange (#f08a3c)").getAttribute("aria-checked")).toBe("true");
    expect(hex().value).toBe("#f08a3c");
    const preview = document.querySelector(".colour-preview")!;
    expect(preview.textContent).toContain("Moderator");
    expect(preview.textContent).toContain("#f08a3c");
  });

  it("moves between the presets with the arrow keys, selecting as it goes", () => {
    open({ value: "#6c7cff" }); // Indigo, the first preset after 'No colour'
    radio("Indigo (#6c7cff)").focus();

    fireEvent.keyDown(radio("Indigo (#6c7cff)"), { key: "ArrowRight" });
    expect(radio("Blue (#3b9cf5)").getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(radio("Blue (#3b9cf5)"));

    fireEvent.keyDown(radio("Blue (#3b9cf5)"), { key: "ArrowLeft" });
    fireEvent.keyDown(radio("Indigo (#6c7cff)"), { key: "ArrowLeft" });
    expect(radio("No colour").getAttribute("aria-checked")).toBe("true");
    expect(hex().value).toBe("");
  });

  it("wraps from the last preset round to 'No colour'", () => {
    open({ value: "#e7e7ea" }); // White, the last one
    fireEvent.keyDown(radio("White (#e7e7ea)"), { key: "ArrowRight" });

    expect(radio("No colour").getAttribute("aria-checked")).toBe("true");
  });
});

describe("ColourPickerModal: the hex field", () => {
  it("is invalid until the colour is complete, and Apply waits for it", () => {
    open();

    fireEvent.change(hex(), { target: { value: "#ff88" } });

    expect(hex().getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText(/not a complete colour/)).toBeTruthy();
    expect(apply().disabled).toBe(true);
  });

  it("accepts a complete colour, whatever the case and with or without the hash, and updates everything", () => {
    open();

    fireEvent.change(hex(), { target: { value: "FF8800" } });

    expect(hex().getAttribute("aria-invalid")).toBe("false");
    expect(apply().disabled).toBe(false);
    expect(document.querySelector(".colour-preview")!.textContent).toContain("#ff8800");
    expect(slider("Hue").value).toBe("32");
    expect(slider("Saturation").value).toBe("100");
    expect(slider("Brightness").value).toBe("100");
  });

  it("reads the short form", () => {
    const { onApply } = open();

    fireEvent.change(hex(), { target: { value: "#f80" } });
    fireEvent.click(apply());

    expect(onApply).toHaveBeenCalledWith("#ff8800");
  });

  it("turns invalid again when a valid colour is spoiled", () => {
    open();

    fireEvent.change(hex(), { target: { value: "#ff8800" } });
    fireEvent.change(hex(), { target: { value: "#ff880x" } });

    expect(apply().disabled).toBe(true);
  });

  it("an empty field means no colour, and is allowed", () => {
    open({ value: "#ff8800" });

    fireEvent.change(hex(), { target: { value: "" } });

    expect(hex().getAttribute("aria-invalid")).toBe("false");
    expect(apply().disabled).toBe(false);
  });
});

describe("ColourPickerModal: the sliders", () => {
  it("builds the colour from hue, saturation and brightness, and keeps the hex field in step", () => {
    open({ value: "#ff0000" });

    fireEvent.change(slider("Hue"), { target: { value: "120" } });
    expect(hex().value).toBe("#00ff00");

    fireEvent.change(slider("Saturation"), { target: { value: "0" } });
    expect(hex().value).toBe("#ffffff");

    fireEvent.change(slider("Brightness"), { target: { value: "50" } });
    expect(hex().value).toBe("#808080");
  });

  it("announces each value with its unit", () => {
    open({ value: "#ff0000" });
    fireEvent.change(slider("Hue"), { target: { value: "200" } });

    expect(slider("Hue").getAttribute("aria-valuetext")).toBe("200 degrees");
    expect(slider("Saturation").getAttribute("aria-valuetext")).toBe("100 percent");
    expect(slider("Brightness").getAttribute("aria-valuetext")).toBe("100 percent");
  });

  it("applies a colour made with the sliders", () => {
    const { onApply } = open({ value: "#ff0000" });

    fireEvent.change(slider("Hue"), { target: { value: "240" } });
    fireEvent.click(apply());

    expect(onApply).toHaveBeenCalledWith("#0000ff");
  });

  it("deselects the preset once the colour is no longer one", () => {
    open({ value: "#3bc47e" });

    fireEvent.change(slider("Brightness"), { target: { value: "40" } });

    expect(radio("Green (#3bc47e)").getAttribute("aria-checked")).toBe("false");
  });
});

describe("ColourPickerModal: the square", () => {
  // A pointer shortcut for the saturation and brightness sliders (aria-hidden: the sliders are the keyboard route).
  it("sets saturation and brightness from where it is pressed", () => {
    open({ value: "#ff0000" });
    const square = document.querySelector(".colour-square") as HTMLElement;
    expect(square.getAttribute("aria-hidden")).toBe("true");
    square.getBoundingClientRect = () => ({ left: 100, top: 50, width: 200, height: 100, right: 300, bottom: 150, x: 100, y: 50, toJSON: () => ({}) });

    fireEvent.pointerDown(square, { clientX: 200, clientY: 75, pointerId: 1 }); // halfway across, a quarter down

    expect(slider("Saturation").value).toBe("50");
    expect(slider("Brightness").value).toBe("75");
  });

  it("follows the pointer only while it is held", () => {
    open({ value: "#ff0000" });
    const square = document.querySelector(".colour-square") as HTMLElement;
    square.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });

    fireEvent.pointerMove(square, { clientX: 10, clientY: 10, pointerId: 1 });
    expect(slider("Saturation").value).toBe("100"); // not pressed: nothing happens

    fireEvent.pointerDown(square, { clientX: 20, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(square, { clientX: 40, clientY: 100, pointerId: 1 });
    expect(slider("Saturation").value).toBe("40");
    expect(slider("Brightness").value).toBe("0");

    fireEvent.pointerUp(square, { pointerId: 1 });
    fireEvent.pointerMove(square, { clientX: 90, clientY: 50, pointerId: 1 });
    expect(slider("Saturation").value).toBe("40"); // released: stays
  });
});

describe("ColourPickerModal: the preview and the contrast warning", () => {
  it("shows the chip on the dark sidebar, with the name it was given", () => {
    open({ value: "#3bc47e" });

    const chip = document.querySelector(".colour-preview-chip")!;
    expect(chip.textContent).toBe("Moderator");
  });

  it("warns, without blocking, about a colour that is hard to see on the sidebar", () => {
    open();

    fireEvent.change(hex(), { target: { value: "#1b1c22" } });

    expect(screen.getByRole("status").textContent).toContain("hard to see");
    expect(apply().disabled).toBe(false);
  });

  it("does not warn about any preset, or about no colour", () => {
    open();
    expect(screen.queryByRole("status")).toBeNull();

    for (const preset of screen.getAllByRole("radio")) {
      fireEvent.click(preset);
      expect(screen.queryByRole("status")).toBeNull();
    }
  });
});

describe("ColourPickerModal: cancel, confirm, and the keyboard", () => {
  it("Apply gives the colour back and closes", () => {
    const { onApply, onClose } = open();

    fireEvent.click(radio("Pink (#e45cb0)"));
    fireEvent.click(apply());

    expect(onApply).toHaveBeenCalledWith("#e45cb0");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Apply with 'No colour' gives null", () => {
    const { onApply } = open({ value: "#e45cb0" });

    fireEvent.click(radio("No colour"));
    fireEvent.click(apply());

    expect(onApply).toHaveBeenCalledWith(null);
  });

  it("Cancel closes without applying anything", () => {
    const { onApply, onClose } = open();

    fireEvent.click(radio("Pink (#e45cb0)"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Escape closes without applying anything", () => {
    const { onApply, onClose } = open();

    fireEvent.click(radio("Pink (#e45cb0)"));
    fireEvent.keyDown(document, { key: "Escape" });

    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Enter in a slider confirms", () => {
    const { onApply, onClose } = open({ value: "#ff0000" });

    fireEvent.change(slider("Hue"), { target: { value: "240" } });
    fireEvent.keyDown(slider("Hue"), { key: "Enter" });

    expect(onApply).toHaveBeenCalledWith("#0000ff");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("submitting the form (Enter in the hex field) confirms", () => {
    const { onApply } = open();

    fireEvent.change(hex(), { target: { value: "#112233" } });
    fireEvent.submit(hex().closest("form")!);

    expect(onApply).toHaveBeenCalledWith("#112233");
  });

  it("does not confirm an invalid colour, however it is submitted", () => {
    const { onApply, onClose } = open();

    fireEvent.change(hex(), { target: { value: "#12" } });
    fireEvent.submit(hex().closest("form")!);

    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the hex field away from password managers", () => {
    open();

    expect(hex().getAttribute("autocomplete")).toBe("off");
    expect(hex().hasAttribute("data-1p-ignore")).toBe(true);
  });
});
