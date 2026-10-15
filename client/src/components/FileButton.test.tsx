import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import FileButton from "./FileButton";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const picture = () => new File(["x"], "face.png", { type: "image/png" });
const nativeInput = () => document.querySelector('input[type="file"]') as HTMLInputElement;

describe("FileButton", () => {
  it("shows the app's own button and 'No file chosen', with the native input hidden", () => {
    render(<FileButton file={null} onChange={vi.fn()} accept="image/*" />);

    expect(screen.getByRole("button", { name: "Choose file" }).className).toContain("btn-secondary");
    expect(screen.getByText("No file chosen")).not.toBeNull();
    expect(nativeInput().hidden).toBe(true);
    expect(nativeInput().getAttribute("accept")).toBe("image/*");
  });

  it("opens the native file dialog from the button", () => {
    const open = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    render(<FileButton file={null} onChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Choose file" }));

    expect(open).toHaveBeenCalledOnce();
  });

  it("reports the chosen file", () => {
    const onChange = vi.fn();
    render(<FileButton file={null} onChange={onChange} />);
    const file = picture();

    fireEvent.change(nativeInput(), { target: { files: [file] } });

    expect(onChange).toHaveBeenCalledWith(file);
  });

  it("shows the name of the chosen file", () => {
    render(<FileButton file={picture()} onChange={vi.fn()} />);

    expect(screen.getByText("face.png")).not.toBeNull();
    expect(screen.queryByText("No file chosen")).toBeNull();
  });

  it("reports no file when the choice is cancelled", () => {
    const onChange = vi.fn();
    render(<FileButton file={picture()} onChange={onChange} />);

    fireEvent.change(nativeInput(), { target: { files: [] } });

    expect(onChange).toHaveBeenCalledWith(null);
  });

  // A hidden input remembers its file; without clearing it, the same picture could not be
  // chosen again after an upload (no change event fires for an unchanged value).
  it("clears the hidden input when the file is set back to nothing", () => {
    const { rerender } = render(<FileButton file={picture()} onChange={vi.fn()} />);
    const input = nativeInput();
    Object.defineProperty(input, "value", { value: "C:\\fakepath\\face.png", writable: true, configurable: true });

    rerender(<FileButton file={null} onChange={vi.fn()} />);

    expect(input.value).toBe("");
  });

  it("disables the button when disabled", () => {
    render(<FileButton file={null} onChange={vi.fn()} disabled />);

    expect((screen.getByRole("button", { name: "Choose file" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
