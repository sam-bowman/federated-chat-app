import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLIP_LEVEL, MicrophoneLevel, buildLevelGraph, startMicrophoneTest } from "./micLevel";

// jsdom has no audio engine, so this one records how the nodes are joined and answers what the meter would read.
class FakeNode {
  kind: string;
  connections: FakeNode[] = [];
  disconnected = false;
  constructor(kind: string) {
    this.kind = kind;
  }
  connect(to: FakeNode) {
    this.connections.push(to);
    return to;
  }
  disconnect() {
    this.disconnected = true;
  }
}
class FakeParam {
  value = 0;
  setTargetAtTime = vi.fn();
}
class FakeTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}
class FakeStream {
  tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = tracks;
  }
  getAudioTracks() {
    return this.tracks;
  }
  getTracks() {
    return this.tracks;
  }
}

class FakeContext {
  static last: FakeContext;
  currentTime = 5;
  closed = false;
  nodes: Record<string, FakeNode & Record<string, any>> = {};
  samples = new Float32Array(1024);
  constructor() {
    FakeContext.last = this;
  }
  private make(kind: string, extra: Record<string, unknown> = {}) {
    const node = Object.assign(new FakeNode(kind), extra);
    this.nodes[kind] = node;
    return node;
  }
  createMediaStreamSource(stream: FakeStream) {
    return this.make("source", { stream });
  }
  createGain() {
    return this.make("gain", { gain: new FakeParam() });
  }
  createAnalyser() {
    const self = this;
    return this.make("meter", {
      fftSize: 0,
      getFloatTimeDomainData(into: Float32Array) {
        into.set(self.samples.subarray(0, into.length));
      },
    });
  }
  createDynamicsCompressor() {
    return this.make("limiter", { threshold: new FakeParam(), knee: new FakeParam(), ratio: new FakeParam(), attack: new FakeParam(), release: new FakeParam() });
  }
  createMediaStreamDestination() {
    return this.make("destination", { stream: new FakeStream([new FakeTrack()]) });
  }
  close = vi.fn(async () => {
    this.closed = true;
  });
}

beforeEach(() => {
  vi.stubGlobal("MediaStream", FakeStream);
});
afterEach(() => vi.unstubAllGlobals());

const context = () => new FakeContext() as unknown as AudioContext;
const track = () => new FakeTrack() as unknown as MediaStreamTrack;

describe("the microphone's level graph", () => {
  it("joins the microphone to a gain, a meter, a limiter and what is sent, in that order", () => {
    const ctx = context();
    buildLevelGraph(ctx, track(), 100);
    const n = FakeContext.last.nodes;
    expect(n.source.connections).toEqual([n.gain]);
    expect(n.gain.connections).toEqual([n.meter]);
    expect(n.meter.connections).toEqual([n.limiter]);
    expect(n.limiter.connections).toEqual([n.destination]);
  });

  it("starts at the volume it is given, and sends the track the destination makes", () => {
    const graph = buildLevelGraph(context(), track(), 150);
    expect(FakeContext.last.nodes.gain.gain.value).toBe(1.5);
    expect(graph.output).toBe((FakeContext.last.nodes.destination.stream as FakeStream).getAudioTracks()[0]);
  });

  it("is a limiter: nothing above -3 dB, caught fast and let go gently", () => {
    buildLevelGraph(context(), track(), 100);
    const limiter = FakeContext.last.nodes.limiter;
    expect(limiter.threshold.value).toBe(-3);
    expect(limiter.knee.value).toBe(0);
    expect(limiter.ratio.value).toBe(20);
    expect(limiter.attack.value).toBeLessThan(0.01);
    expect(limiter.release.value).toBeGreaterThan(limiter.attack.value);
  });

  it("changes the volume with a short ramp, so moving the slider does not click", () => {
    const graph = buildLevelGraph(context(), track(), 100);
    graph.setGain(200);
    const [value, at, smoothing] = FakeContext.last.nodes.gain.gain.setTargetAtTime.mock.calls[0];
    expect(value).toBe(2);
    expect(at).toBe(5);
    expect(smoothing).toBeGreaterThan(0);
    expect(smoothing).toBeLessThan(0.1);
  });

  it("reads the meter before the limiter, as the loudest sample, whichever way it swings", () => {
    const graph = buildLevelGraph(context(), track(), 100);
    expect(graph.peak()).toBe(0);
    FakeContext.last.samples[10] = 0.3;
    FakeContext.last.samples[500] = -0.8;
    expect(graph.peak()).toBeCloseTo(0.8);
    FakeContext.last.samples[900] = 1.7; // a boost past full scale shows above 1, before the limiter
    expect(graph.peak()).toBeCloseTo(1.7);
    expect(FakeContext.last.nodes.meter.fftSize).toBe(1024);
    expect(CLIP_LEVEL).toBeLessThan(1);
  });

  it("lets go of everything when it is finished", () => {
    const graph = buildLevelGraph(context(), track(), 100);
    graph.destroy();
    for (const kind of ["source", "gain", "meter", "limiter", "destination"]) expect(FakeContext.last.nodes[kind].disconnected, kind).toBe(true);
    expect((FakeContext.last.nodes.destination.stream as FakeStream).getTracks().every((t) => t.stopped)).toBe(true);
  });
});

describe("the processor on the microphone being sent", () => {
  const options = (ctx: AudioContext) => ({ audioContext: ctx, track: track(), kind: "audio" }) as never;

  it("sends what the graph makes instead of the raw microphone, once started", async () => {
    const processor = new MicrophoneLevel(150);
    expect(processor.name).toBe("microphone-level");
    expect(processor.processedTrack).toBeUndefined();
    await processor.init(options(context()));
    expect(processor.processedTrack).toBeDefined();
    expect(FakeContext.last.nodes.gain.gain.value).toBe(1.5);
  });

  it("changes the volume live, and remembers it for a graph made later", async () => {
    const processor = new MicrophoneLevel(100);
    processor.setPercent(180); // before there is a graph
    await processor.init(options(context()));
    expect(FakeContext.last.nodes.gain.gain.value).toBe(1.8);
    processor.setPercent(50);
    expect(FakeContext.last.nodes.gain.gain.setTargetAtTime.mock.calls.at(-1)?.[0]).toBe(0.5);
  });

  it("reads the level, and nothing before it starts", async () => {
    const processor = new MicrophoneLevel(100);
    expect(processor.peak()).toBe(0);
    await processor.init(options(context()));
    FakeContext.last.samples[3] = 0.4;
    expect(processor.peak()).toBeCloseTo(0.4);
  });

  it("builds a new graph, and lets go of the old one, when the microphone changes", async () => {
    const processor = new MicrophoneLevel(120);
    await processor.init(options(context()));
    const first = FakeContext.last;
    await processor.restart(options(context()));
    expect(first.nodes.gain.disconnected).toBe(true);
    expect(FakeContext.last).not.toBe(first);
    expect(FakeContext.last.nodes.gain.gain.value).toBe(1.2);
    expect(processor.processedTrack).toBeDefined();
  });

  it("lets go of everything when it is taken off", async () => {
    const processor = new MicrophoneLevel(100);
    await processor.init(options(context()));
    await processor.destroy();
    expect(FakeContext.last.nodes.gain.disconnected).toBe(true);
    expect(processor.processedTrack).toBeUndefined();
    expect(processor.peak()).toBe(0);
    await expect(processor.destroy()).resolves.toBeUndefined();
  });
});

describe("testing the microphone on its own", () => {
  let getUserMedia: ReturnType<typeof vi.fn>;
  let micTrack: FakeTrack;
  beforeEach(() => {
    micTrack = new FakeTrack();
    getUserMedia = vi.fn(async () => new FakeStream([micTrack]));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("AudioContext", FakeContext);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());
  const defaults = { deviceId: null, outputDeviceId: null, echoCancellation: true, noiseSuppression: true, autoGainControl: true, percent: 100 };

  it("opens the microphone the person chose, with the browser's processing as they chose it", async () => {
    await startMicrophoneTest({ ...defaults, deviceId: "mic-7", echoCancellation: false, autoGainControl: false });
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { deviceId: { exact: "mic-7" }, echoCancellation: false, noiseSuppression: true, autoGainControl: false },
    });
  });

  it("uses the system's own microphone when none was chosen", async () => {
    await startMicrophoneTest(defaults);
    expect(getUserMedia.mock.calls[0][0].audio.deviceId).toBeUndefined();
  });

  it("shows the level at the volume chosen, and changes with the slider", async () => {
    const test = await startMicrophoneTest({ ...defaults, percent: 150 });
    expect(FakeContext.last.nodes.gain.gain.value).toBe(1.5);
    FakeContext.last.samples[1] = 0.6;
    expect(test.peak()).toBeCloseTo(0.6);
    test.setGain(50);
    expect(FakeContext.last.nodes.gain.gain.setTargetAtTime.mock.calls.at(-1)?.[0]).toBe(0.5);
  });

  it("plays the person back only when asked, and stops when asked", async () => {
    const test = await startMicrophoneTest(defaults);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    test.setLoopback(true);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    test.setLoopback(false);
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  });

  it("lets go of the microphone and the audio engine when stopped", async () => {
    const test = await startMicrophoneTest(defaults);
    test.stop();
    expect(micTrack.stopped).toBe(true);
    expect(FakeContext.last.nodes.gain.disconnected).toBe(true);
    expect(FakeContext.last.close).toHaveBeenCalled();
  });

  it("fails as the browser does when the microphone cannot be opened, for the caller to explain", async () => {
    getUserMedia.mockRejectedValue(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    await expect(startMicrophoneTest(defaults)).rejects.toMatchObject({ name: "NotAllowedError" });
  });
});
