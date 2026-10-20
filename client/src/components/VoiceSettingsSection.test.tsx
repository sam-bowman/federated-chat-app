import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import VoiceSettingsSection from "./VoiceSettingsSection";

const voice = vi.hoisted(() => ({ value: {} as Record<string, any> }));
vi.mock("../context/VoiceContext", () => ({ useVoice: () => voice.value }));

const micTest = vi.hoisted(() => ({
  start: vi.fn(),
  current: null as null | { peak: ReturnType<typeof vi.fn>; setGain: ReturnType<typeof vi.fn>; setLoopback: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> },
}));
vi.mock("../lib/micLevel", () => ({ CLIP_LEVEL: 0.99, startMicrophoneTest: micTest.start }));

const audio = (overrides: Record<string, any> = {}) => ({
  inputVolume: 100,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  outputVolume: 100,
  people: {},
  ...overrides,
});

function setVoice(overrides: Record<string, any> = {}) {
  voice.value = {
    audio: audio(),
    devices: {
      inputs: [{ id: "m1", label: "Desk mic" }, { id: "m2", label: "Headset" }],
      outputs: [{ id: "s1", label: "Speakers" }],
      prefs: { input: null, output: null },
    },
    refreshDevices: vi.fn().mockResolvedValue(undefined),
    chooseInput: vi.fn().mockResolvedValue(undefined),
    chooseOutput: vi.fn().mockResolvedValue(undefined),
    setInputVolume: vi.fn(),
    setOutputVolume: vi.fn(),
    setProcessing: vi.fn().mockResolvedValue(undefined),
    setPerson: vi.fn(),
    resetPeople: vi.fn(),
    ...overrides,
  };
}

function newTest(peak = 0) {
  micTest.current = { peak: vi.fn(() => peak), setGain: vi.fn(), setLoopback: vi.fn(), stop: vi.fn() };
  return micTest.current;
}

beforeEach(() => {
  setVoice();
  micTest.start.mockReset();
  micTest.start.mockImplementation(async () => newTest());
  // The meter is read every animation frame: run it by hand so a test controls the clock.
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Settings -> Voice & audio", () => {
  it("refreshes the device lists when it opens, since they change when something is plugged in", () => {
    render(<VoiceSettingsSection />);
    expect(voice.value.refreshDevices).toHaveBeenCalledTimes(1);
  });

  it("chooses the microphone and the speaker, and goes back to the system's own", () => {
    setVoice({ devices: { ...voice.value.devices, prefs: { input: "m1", output: null } } });
    render(<VoiceSettingsSection />);
    expect((screen.getByLabelText("Microphone") as HTMLSelectElement).value).toBe("m1");
    fireEvent.change(screen.getByLabelText("Microphone"), { target: { value: "m2" } });
    expect(voice.value.chooseInput).toHaveBeenCalledWith("m2");
    fireEvent.change(screen.getByLabelText("Microphone"), { target: { value: "" } });
    expect(voice.value.chooseInput).toHaveBeenLastCalledWith(null);
    fireEvent.change(screen.getByLabelText("Speaker"), { target: { value: "s1" } });
    expect(voice.value.chooseOutput).toHaveBeenCalledWith("s1");
  });

  it("sets how loud you are for everyone, and how loud everyone is for you", () => {
    render(<VoiceSettingsSection />);
    fireEvent.change(screen.getByLabelText("Input volume"), { target: { value: "150" } });
    expect(voice.value.setInputVolume).toHaveBeenCalledWith(150);
    fireEvent.change(screen.getByLabelText("Master volume"), { target: { value: "40" } });
    expect(voice.value.setOutputVolume).toHaveBeenCalledWith(40);
  });

  it("turns the browser's processing on and off, one at a time", () => {
    render(<VoiceSettingsSection />);
    fireEvent.click(screen.getByLabelText("Echo cancellation"));
    expect(voice.value.setProcessing).toHaveBeenLastCalledWith("echoCancellation", false);
    fireEvent.click(screen.getByLabelText("Noise suppression"));
    expect(voice.value.setProcessing).toHaveBeenLastCalledWith("noiseSuppression", false);
    fireEvent.click(screen.getByLabelText(/Automatic gain/));
    expect(voice.value.setProcessing).toHaveBeenLastCalledWith("autoGainControl", false);
  });

  it("warns that automatic gain fights a changed input volume, and only then", () => {
    const { unmount } = render(<VoiceSettingsSection />);
    expect(screen.queryByText(/works against the input volume/)).toBeNull(); // untouched volume
    unmount();
    setVoice({ audio: audio({ inputVolume: 150 }) });
    const { unmount: again } = render(<VoiceSettingsSection />);
    expect(screen.getByText(/works against the input volume/)).not.toBeNull();
    again();
    setVoice({ audio: audio({ inputVolume: 150, autoGainControl: false }) });
    render(<VoiceSettingsSection />);
    expect(screen.queryByText(/works against the input volume/)).toBeNull(); // nothing fighting it
  });

  describe("the people you have adjusted", () => {
    it("says nobody, when nobody is", () => {
      render(<VoiceSettingsSection />);
      expect(screen.getByText(/Nobody: everyone is at 100%/)).not.toBeNull();
      expect(screen.queryByRole("button", { name: "Reset everyone" })).toBeNull();
    });

    it("lists each by their full identity with what was set, and puts one or all back", () => {
      setVoice({
        audio: audio({
          people: {
            "@bea:one.example": { volume: 150, muted: false },
            "@cy:two.example": { volume: 100, muted: true },
          },
        }),
      });
      render(<VoiceSettingsSection />);
      expect(screen.getByText("@bea:one.example")).not.toBeNull();
      expect(screen.getByText("150%")).not.toBeNull();
      expect(screen.getByText("@cy:two.example")).not.toBeNull();
      expect(screen.getByText("Muted for you")).not.toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Put @bea:one.example back to 100%" }));
      expect(voice.value.setPerson).toHaveBeenCalledWith("@bea:one.example", { volume: 100, muted: false });
      fireEvent.click(screen.getByRole("button", { name: "Reset everyone" }));
      expect(voice.value.resetPeople).toHaveBeenCalled();
    });

    it("leaves out anyone who has been put back to the defaults", () => {
      setVoice({ audio: audio({ people: { "@dan:one.example": { volume: 100, muted: false } } }) });
      render(<VoiceSettingsSection />);
      expect(screen.queryByText("@dan:one.example")).toBeNull();
    });
  });

  describe("testing the microphone", () => {
    it("opens it with the choices made, only when asked", async () => {
      setVoice({
        audio: audio({ inputVolume: 130, echoCancellation: false }),
        devices: { ...voice.value.devices, prefs: { input: "m2", output: "s1" } },
      });
      render(<VoiceSettingsSection />);
      expect(micTest.start).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Test my microphone" }));
      await waitFor(() => expect(micTest.start).toHaveBeenCalledTimes(1));
      expect(micTest.start).toHaveBeenCalledWith({
        deviceId: "m2",
        outputDeviceId: "s1",
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: true,
        percent: 130,
      });
      expect(screen.getByRole("button", { name: "Stop testing" }).getAttribute("aria-pressed")).toBe("true");
    });

    it("lets go of the microphone when stopped, and when the page goes away", async () => {
      const { unmount } = render(<VoiceSettingsSection />);
      fireEvent.click(screen.getByRole("button", { name: "Test my microphone" }));
      await waitFor(() => expect(micTest.current).not.toBeNull());
      const first = micTest.current!;
      fireEvent.click(screen.getByRole("button", { name: "Stop testing" }));
      await waitFor(() => expect(first.stop).toHaveBeenCalled());

      fireEvent.click(screen.getByRole("button", { name: "Test my microphone" }));
      await waitFor(() => expect(micTest.current).not.toBe(first));
      const second = micTest.current!;
      unmount();
      expect(second.stop).toHaveBeenCalled();
    });

    it("stops a test that opened after the person had already stopped it", async () => {
      let open!: (value: ReturnType<typeof newTest>) => void;
      micTest.start.mockImplementation(() => new Promise((resolve) => (open = resolve)));
      render(<VoiceSettingsSection />);
      fireEvent.click(screen.getByRole("button", { name: "Test my microphone" }));
      fireEvent.click(screen.getByRole("button", { name: "Stop testing" }));
      const late = newTest();
      await act(async () => open(late));
      expect(late.stop).toHaveBeenCalled();
    });

    it("shows the level as it is read, and warns when it clips", async () => {
      const frames: Array<() => void> = [];
      vi.stubGlobal("requestAnimationFrame", (fn: () => void) => frames.push(fn));
      micTest.start.mockImplementation(async () => newTest(0.5));
      render(<VoiceSettingsSection />);
      fireEvent.click(screen.getByRole("button", { name: "Test my microphone" }));
      await waitFor(() => expect(screen.getByRole("meter", { name: "Microphone level" }).getAttribute("aria-valuenow")).toBe("50"));
      expect(screen.queryByText(/Too loud/)).toBeNull();

      micTest.current!.peak.mockReturnValue(1.4); // a boost past full scale
      await act(async () => frames.shift()!());
      expect(screen.getByRole("meter", { name: "Microphone level" }).getAttribute("aria-valuenow")).toBe("100"); // never past the end
      expect(screen.getByText(/Too loud/)).not.toBeNull();
    });

    it("moves the volume and the playback into the running test at once", async () => {
      const { rerender } = render(<VoiceSettingsSection />);
      fireEvent.click(screen.getByRole("button", { name: "Test my microphone" }));
      await waitFor(() => expect(micTest.current).not.toBeNull());
      const running = micTest.current!;
      expect(running.setLoopback).toHaveBeenCalledWith(false);

      fireEvent.click(screen.getByLabelText(/Hear myself/));
      expect(running.setLoopback).toHaveBeenLastCalledWith(true);

      setVoice({ audio: audio({ inputVolume: 170 }) });
      rerender(<VoiceSettingsSection />);
      expect(running.setGain).toHaveBeenLastCalledWith(170);
    });

    it("explains why when the microphone cannot be opened, and is not left testing", async () => {
      micTest.start.mockRejectedValue(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
      render(<VoiceSettingsSection />);
      fireEvent.click(screen.getByRole("button", { name: "Test my microphone" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Test my microphone" })).not.toBeNull());
      expect(screen.getByText(/microphone/i, { selector: ".error-text" })).not.toBeNull();
    });
  });
});
