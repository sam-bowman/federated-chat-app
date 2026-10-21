import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CallQualityReadout from "./CallQualityReadout";

const voice = vi.hoisted(() => ({ value: {} as Record<string, any> }));
vi.mock("../context/VoiceContext", () => ({ useVoice: () => voice.value }));

const sample = (rtt: number, transport = "udp", extra: Record<string, unknown> = {}) => ({
  sent: [
    { type: "transport", id: "T", selectedCandidatePairId: "P" },
    { type: "candidate-pair", id: "P", localCandidateId: "L", remoteCandidateId: "R", nominated: true, state: "succeeded" },
    { type: "local-candidate", id: "L", protocol: transport, candidateType: "host" },
    { type: "remote-candidate", id: "R", protocol: transport, candidateType: "srflx" },
    { type: "remote-inbound-rtp", kind: "audio", roundTripTime: rtt },
  ],
  received: [[{ type: "inbound-rtp", kind: "audio", jitter: 0.01, jitterBufferDelay: 2, jitterBufferEmittedCount: 20, packetsLost: 0, packetsReceived: 100, ...extra }]],
});

beforeEach(() => {
  vi.useFakeTimers();
  voice.value = { sampleCallStats: vi.fn().mockResolvedValue(sample(0.06)) };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));

describe("the call quality readout", () => {
  it("says it is measuring until the first numbers arrive, then shows them", async () => {
    voice.value.sampleCallStats = vi.fn(() => new Promise(() => undefined));
    render(<CallQualityReadout />);
    expect(screen.getByRole("status").textContent).toBe("Measuring…");

    cleanup();
    voice.value.sampleCallStats = vi.fn().mockResolvedValue(sample(0.06));
    render(<CallQualityReadout />);
    await settle();
    expect(screen.getByRole("status").textContent).toBe("Good");
    expect(screen.getByText("Round trip to the voice server").nextElementSibling?.textContent).toBe("60 ms");
    expect(screen.getByText("Audio waits before playing").nextElementSibling?.textContent).toBe("100 ms");
    expect(screen.getByText("Delay (network and buffering)").nextElementSibling?.textContent).toBe("130 ms"); // 60/2 + 100
    expect(screen.getByText("Jitter").nextElementSibling?.textContent).toBe("10 ms");
    expect(screen.getByText("Audio lost").nextElementSibling?.textContent).toBe("0.0%");
    expect(screen.getByText("Connection").nextElementSibling?.textContent).toBe("UDP, through your router");
  });

  it("reads again every couple of seconds, and stops when it is closed", async () => {
    const { unmount } = render(<CallQualityReadout />);
    await settle();
    expect(voice.value.sampleCallStats).toHaveBeenCalledTimes(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(2000)));
    expect(voice.value.sampleCallStats).toHaveBeenCalledTimes(2);
    unmount();
    await act(async () => void (await vi.advanceTimersByTimeAsync(10000)));
    expect(voice.value.sampleCallStats).toHaveBeenCalledTimes(2);
  });

  it("says plainly when the connection is TCP, which is a sign the audio ports are blocked", async () => {
    voice.value.sampleCallStats = vi.fn().mockResolvedValue(sample(0.06, "tcp"));
    render(<CallQualityReadout />);
    await settle();
    expect(screen.getByText("Connection").nextElementSibling?.textContent).toMatch(/^TCP.*not reachable/);
    expect(screen.getByRole("status").textContent).toBe("Fair");
  });

  it("shows dashes for what cannot be known yet (nobody else is in the call), and keeps going when a read fails", async () => {
    voice.value.sampleCallStats = vi
      .fn()
      .mockResolvedValueOnce({ ...sample(0.06), received: [] })
      .mockRejectedValue(new Error("gone"));
    render(<CallQualityReadout />);
    await settle();
    expect(screen.getByText("Audio waits before playing").nextElementSibling?.textContent).toBe("–");
    expect(screen.getByText("Audio lost").nextElementSibling?.textContent).toBe("–");
    await act(async () => void (await vi.advanceTimersByTimeAsync(2000)));
    expect(screen.getByText("Round trip to the voice server").nextElementSibling?.textContent).toBe("60 ms"); // what it had stays
  });

  it("is poor when the delay is long", async () => {
    voice.value.sampleCallStats = vi.fn().mockResolvedValue(sample(0.6));
    render(<CallQualityReadout />);
    await settle();
    expect(screen.getByRole("status").textContent).toBe("Poor");
  });
});
