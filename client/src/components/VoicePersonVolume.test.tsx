import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import VoicePersonVolume from "./VoicePersonVolume";

const voice = vi.hoisted(() => ({ value: {} as Record<string, any> }));
vi.mock("../context/VoiceContext", () => ({ useVoice: () => voice.value }));

function setVoice(people: Record<string, { volume: number; muted: boolean }> = {}) {
  voice.value = {
    audio: { inputVolume: 100, echoCancellation: true, noiseSuppression: true, autoGainControl: true, outputVolume: 100, people },
    setPerson: vi.fn(),
  };
}
afterEach(cleanup);

const open = () => fireEvent.click(screen.getByRole("button", { name: "Volume for Alice" }));

describe("one person's volume in the call", () => {
  it("is a button next to them, closed until pressed", () => {
    setVoice();
    render(<VoicePersonVolume identity="@alice:chat.example" name="Alice" />);
    const button = screen.getByRole("button", { name: "Volume for Alice" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("slider")).toBeNull();
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("slider", { name: "Alice's volume" })).not.toBeNull();
    fireEvent.click(button);
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("shows 100% and not muted for someone nothing was set for, and says it is only heard by this person", () => {
    setVoice();
    render(<VoicePersonVolume identity="@alice:chat.example" name="Alice" />);
    open();
    expect((screen.getByRole("slider") as HTMLInputElement).value).toBe("100");
    expect((screen.getByRole("checkbox", { name: "Mute for me" }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText("Only you hear this change.")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Volume for Alice" }).textContent).toBe("🔉");
  });

  it("changes the volume of that person, by identity, and nobody else", () => {
    setVoice();
    render(<VoicePersonVolume identity="@alice:chat.example" name="Alice" />);
    open();
    fireEvent.change(screen.getByRole("slider"), { target: { value: "150" } });
    expect(voice.value.setPerson).toHaveBeenCalledWith("@alice:chat.example", { volume: 150 });
  });

  it("mutes and unmutes them for this person", () => {
    setVoice();
    render(<VoicePersonVolume identity="@alice:chat.example" name="Alice" />);
    open();
    fireEvent.click(screen.getByRole("checkbox", { name: "Mute for me" }));
    expect(voice.value.setPerson).toHaveBeenCalledWith("@alice:chat.example", { muted: true });
  });

  it("shows what was set, on the button and in the controls", () => {
    setVoice({ "@alice:chat.example": { volume: 150, muted: false } });
    render(<VoicePersonVolume identity="@alice:chat.example" name="Alice" />);
    const button = screen.getByRole("button", { name: "Volume for Alice" });
    expect(button.textContent).toBe("🔉 150%");
    expect(button.getAttribute("title")).toBe("Alice is 150%");
    open();
    expect((screen.getByRole("slider") as HTMLInputElement).value).toBe("150");
  });

  it("shows a mute as a mute, whatever the volume was", () => {
    setVoice({ "@alice:chat.example": { volume: 150, muted: true } });
    render(<VoicePersonVolume identity="@alice:chat.example" name="Alice" />);
    const button = screen.getByRole("button", { name: "Volume for Alice" });
    expect(button.textContent).toBe("🔇");
    expect(button.getAttribute("title")).toBe("Alice is muted for you");
    open();
    expect((screen.getByRole("checkbox", { name: "Mute for me" }) as HTMLInputElement).checked).toBe(true);
  });

  it("looks only at its own person", () => {
    setVoice({ "@bob:chat.example": { volume: 30, muted: false } });
    render(<VoicePersonVolume identity="@alice:chat.example" name="Alice" />);
    expect(screen.getByRole("button", { name: "Volume for Alice" }).textContent).toBe("🔉");
  });
});
