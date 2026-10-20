import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import VoicePanel from "./VoicePanel";

const voice = vi.hoisted(() => ({ value: {} as Record<string, any> }));
vi.mock("../context/VoiceContext", () => ({ useVoice: () => voice.value }));

const session = (overrides: Record<string, any> = {}) => ({
  channelId: "V1",
  communityId: "C1",
  channelName: "Lounge",
  communityName: "Club",
  status: "connected",
  muted: false,
  deafened: false,
  micProblem: null,
  audioBlocked: false,
  ...overrides,
});

function setVoice(overrides: Record<string, any> = {}) {
  voice.value = {
    session: session(),
    notice: null,
    audio: { inputVolume: 100, echoCancellation: true, noiseSuppression: true, autoGainControl: true, outputVolume: 100, people: {} },
    setPerson: vi.fn(),
    setInputVolume: vi.fn(),
    setOutputVolume: vi.fn(),
    devices: { inputs: [], outputs: [], prefs: { input: null, output: null } },
    dismissNotice: vi.fn(),
    leave: vi.fn(),
    setMuted: vi.fn().mockResolvedValue(undefined),
    setDeafened: vi.fn(),
    allowAudio: vi.fn().mockResolvedValue(undefined),
    refreshDevices: vi.fn().mockResolvedValue(undefined),
    chooseInput: vi.fn().mockResolvedValue(undefined),
    chooseOutput: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

afterEach(cleanup);

describe("the call panel", () => {
  it("is not there with no call and nothing to say", () => {
    setVoice({ session: null });
    const { container } = render(<VoicePanel />);
    expect(container.firstChild).toBeNull();
  });

  it("says which channel the call is in, and that it is connected", () => {
    setVoice();
    render(<VoicePanel />);
    expect(screen.getByRole("region", { name: "Voice call" })).not.toBeNull();
    expect(screen.getByText("Voice connected")).not.toBeNull();
    expect(screen.getByText(/Lounge \/ Club/)).not.toBeNull();
  });

  it("says what the connection is doing", () => {
    for (const [status, words] of [["connecting", "Connecting…"], ["reconnecting", "Reconnecting…"], ["connected", "Voice connected"]] as const) {
      setVoice({ session: session({ status }) });
      const { unmount } = render(<VoicePanel />);
      expect(screen.getByText(words), status).not.toBeNull();
      unmount();
    }
  });

  it("leaves out the community's name when it has none to show", () => {
    setVoice({ session: session({ communityName: "" }) });
    render(<VoicePanel />);
    expect(screen.getByText(/Lounge/).textContent).not.toContain("/");
  });

  it("leaves the call", () => {
    setVoice();
    render(<VoicePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    expect(voice.value.leave).toHaveBeenCalled();
  });

  it("mutes and unmutes, saying which it will do and what is on", () => {
    setVoice();
    const { unmount } = render(<VoicePanel />);
    const mute = screen.getByRole("button", { name: "Mute" });
    expect(mute.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(mute);
    expect(voice.value.setMuted).toHaveBeenCalledWith(true);
    unmount();

    setVoice({ session: session({ muted: true }) });
    render(<VoicePanel />);
    const unmute = screen.getByRole("button", { name: "Unmute" });
    expect(unmute.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(unmute);
    expect(voice.value.setMuted).toHaveBeenCalledWith(false);
  });

  it("deafens and undeafens the same way", () => {
    setVoice();
    const { unmount } = render(<VoicePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Deafen" }));
    expect(voice.value.setDeafened).toHaveBeenCalledWith(true);
    unmount();

    setVoice({ session: session({ deafened: true, muted: true }) });
    render(<VoicePanel />);
    const undeafen = screen.getByRole("button", { name: "Undeafen" });
    expect(undeafen.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(undeafen);
    expect(voice.value.setDeafened).toHaveBeenCalledWith(false);
  });

  it("says why the microphone is not working, and that the call goes on", () => {
    setVoice({ session: session({ muted: true, micProblem: "Your microphone is blocked." }) });
    render(<VoicePanel />);
    expect(screen.getByText("Your microphone is blocked.")).not.toBeNull();
    expect(screen.getByText("Voice connected")).not.toBeNull();
  });

  it("asks for a click when the browser will not play the call by itself", () => {
    setVoice({ session: session({ audioBlocked: true }) });
    render(<VoicePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Click to hear the call" }));
    expect(voice.value.allowAudio).toHaveBeenCalled();
  });

  it("does not ask when audio is playing", () => {
    setVoice();
    render(<VoicePanel />);
    expect(screen.queryByRole("button", { name: "Click to hear the call" })).toBeNull();
  });
});

describe("the choice of microphone and speaker", () => {
  const devices = {
    inputs: [{ id: "m1", label: "Headset" }, { id: "m2", label: "USB mic" }],
    outputs: [{ id: "s1", label: "Speakers" }],
    prefs: { input: "m2", output: null },
  };

  it("is hidden until asked for, and looks for the devices when it opens", () => {
    setVoice({ devices });
    render(<VoicePanel />);
    expect(screen.queryByLabelText("Microphone")).toBeNull();
    const toggle = screen.getByRole("button", { name: "Devices" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(voice.value.refreshDevices).toHaveBeenCalled();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByLabelText("Microphone")).not.toBeNull();
    expect(screen.getByLabelText("Speaker")).not.toBeNull();
  });

  it("has the volume of your microphone and of everyone, changed from the panel", () => {
    setVoice({ devices, audio: { inputVolume: 130, echoCancellation: true, noiseSuppression: true, autoGainControl: true, outputVolume: 70, people: {} } });
    render(<VoicePanel />);
    expect(screen.queryByRole("slider")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Devices" }));
    const mic = screen.getByRole("slider", { name: "Your microphone volume" }) as HTMLInputElement;
    const everyone = screen.getByRole("slider", { name: "Everyone's volume" }) as HTMLInputElement;
    expect(mic.value).toBe("130");
    expect(everyone.value).toBe("70");
    fireEvent.change(mic, { target: { value: "160" } });
    expect(voice.value.setInputVolume).toHaveBeenCalledWith(160);
    fireEvent.change(everyone, { target: { value: "90" } });
    expect(voice.value.setOutputVolume).toHaveBeenCalledWith(90);
  });

  it("closes again, without looking again", () => {
    setVoice({ devices });
    render(<VoicePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Devices" }));
    fireEvent.click(screen.getByRole("button", { name: "Devices" }));
    expect(screen.queryByLabelText("Microphone")).toBeNull();
    expect(voice.value.refreshDevices).toHaveBeenCalledTimes(1);
  });

  it("lists what there is, with the system's own first, and shows the one in use", () => {
    setVoice({ devices });
    render(<VoicePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Devices" }));
    const mic = screen.getByLabelText("Microphone") as HTMLSelectElement;
    expect([...mic.options].map((o) => o.textContent)).toEqual(["System default", "Headset", "USB mic"]);
    expect(mic.value).toBe("m2");
    const speaker = screen.getByLabelText("Speaker") as HTMLSelectElement;
    expect([...speaker.options].map((o) => o.textContent)).toEqual(["System default", "Speakers"]);
    expect(speaker.value).toBe("");
  });

  it("changes the device, and goes back to the system's with no choice", () => {
    setVoice({ devices });
    render(<VoicePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Devices" }));
    fireEvent.change(screen.getByLabelText("Microphone"), { target: { value: "m1" } });
    expect(voice.value.chooseInput).toHaveBeenCalledWith("m1");
    fireEvent.change(screen.getByLabelText("Microphone"), { target: { value: "" } });
    expect(voice.value.chooseInput).toHaveBeenLastCalledWith(null);
    fireEvent.change(screen.getByLabelText("Speaker"), { target: { value: "s1" } });
    expect(voice.value.chooseOutput).toHaveBeenCalledWith("s1");
    fireEvent.change(screen.getByLabelText("Speaker"), { target: { value: "" } });
    expect(voice.value.chooseOutput).toHaveBeenLastCalledWith(null);
  });
});

describe("what the panel says about a call that ended", () => {
  it("shows why, with no call, and can be dismissed", () => {
    setVoice({ session: null, notice: "You were removed from the call." });
    render(<VoicePanel />);
    expect(screen.getByRole("status").textContent).toContain("You were removed from the call.");
    expect(screen.queryByRole("button", { name: "Leave" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(voice.value.dismissNotice).toHaveBeenCalled();
  });

  it("shows a notice above a new call", () => {
    setVoice({ notice: "The call was disconnected." });
    render(<VoicePanel />);
    expect(screen.getByText("The call was disconnected.")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Leave" })).not.toBeNull();
  });
});
