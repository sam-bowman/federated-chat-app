import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import VolumeSlider from "./VolumeSlider";

afterEach(cleanup);

describe("a volume slider", () => {
  it("is a slider from 0% to 200% that the keyboard can move, named, and says its value in words", () => {
    render(<VolumeSlider label="Master volume" value={150} onChange={() => {}} />);
    const slider = screen.getByRole("slider", { name: "Master volume" }) as HTMLInputElement;
    expect(slider.min).toBe("0");
    expect(slider.max).toBe("200");
    expect(slider.step).toBe("5");
    expect(slider.value).toBe("150");
    expect(slider.getAttribute("aria-valuetext")).toBe("150%");
    expect(screen.getByText("150%")).not.toBeNull();
  });

  it("reports what it is moved to, as a number", () => {
    const onChange = vi.fn();
    render(<VolumeSlider label="Master volume" value={100} onChange={onChange} />);
    fireEvent.change(screen.getByRole("slider"), { target: { value: "175" } });
    expect(onChange).toHaveBeenCalledWith(175);
  });

  it("puts the volume back to 100% with a button, which is not offered at 100%", () => {
    const onChange = vi.fn();
    const { rerender } = render(<VolumeSlider label="Master volume" value={160} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset Master volume to 100%" }));
    expect(onChange).toHaveBeenCalledWith(100);
    rerender(<VolumeSlider label="Master volume" value={100} onChange={onChange} />);
    expect((screen.getByRole("button", { name: "Reset Master volume to 100%" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("gives each slider its own label, so two on a page are not confused", () => {
    render(
      <>
        <VolumeSlider label="One" value={10} onChange={() => {}} />
        <VolumeSlider label="Two" value={20} onChange={() => {}} />
      </>
    );
    expect((screen.getByRole("slider", { name: "One" }) as HTMLInputElement).value).toBe("10");
    expect((screen.getByRole("slider", { name: "Two" }) as HTMLInputElement).value).toBe("20");
  });
});
