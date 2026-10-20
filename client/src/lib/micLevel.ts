import type { AudioProcessorOptions, Track, TrackProcessor } from "livekit-client";

// How loud the microphone is, BEFORE it is encoded: a gain, a peak meter, then a limiter, so that boosting a quiet microphone is
// heard by everyone and not just shown on a meter. (Changing only what is played back on this computer would change nothing for
// the other people in the call.) The meter reads the signal after the gain and before the limiter, which is where a boost that is
// too much shows as clipping; the limiter after it is what stops that distorting what is sent.

export const CLIP_LEVEL = 0.99;

export interface LevelGraph {
  /** What to send. */
  output: MediaStreamTrack;
  setGain: (percent: number) => void;
  /** The loudest sample just now, 0 to 1 (more than 1 means the boost is clipping before the limiter catches it). */
  peak: () => number;
  destroy: () => void;
}

export function buildLevelGraph(context: AudioContext, input: MediaStreamTrack, percent: number): LevelGraph {
  const source = context.createMediaStreamSource(new MediaStream([input]));
  const gain = context.createGain();
  gain.gain.value = percent / 100;
  const meter = context.createAnalyser();
  meter.fftSize = 1024;
  const limiter = context.createDynamicsCompressor();
  // A limiter: nothing above -3 dB gets through, caught quickly and let go gently.
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.1;
  const destination = context.createMediaStreamDestination();
  source.connect(gain);
  gain.connect(meter);
  meter.connect(limiter);
  limiter.connect(destination);

  const samples = new Float32Array(meter.fftSize);
  return {
    output: destination.stream.getAudioTracks()[0],
    // A short ramp rather than a jump, so moving the slider does not click.
    setGain: (value) => gain.gain.setTargetAtTime(value / 100, context.currentTime, 0.02),
    peak: () => {
      meter.getFloatTimeDomainData(samples);
      let max = 0;
      for (const sample of samples) {
        const size = Math.abs(sample);
        if (size > max) max = size;
      }
      return max;
    },
    destroy: () => {
      for (const node of [source, gain, meter, limiter, destination]) node.disconnect();
      destination.stream.getTracks().forEach((track) => track.stop());
    },
  };
}

/** Put on the microphone track that is sent into the call (livekit's track processor), so its volume is the person's own choice. */
export class MicrophoneLevel implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name = "microphone-level";
  processedTrack?: MediaStreamTrack;
  private graph?: LevelGraph;
  private percent: number;

  constructor(percent: number) {
    this.percent = percent;
  }

  setPercent(percent: number): void {
    this.percent = percent;
    this.graph?.setGain(percent);
  }

  peak(): number {
    return this.graph?.peak() ?? 0;
  }

  async init(options: AudioProcessorOptions): Promise<void> {
    this.graph = buildLevelGraph(options.audioContext, options.track, this.percent);
    this.processedTrack = this.graph.output;
  }

  // A new microphone (the person chose another, or the processing changed) is a new input track for the same output.
  async restart(options: AudioProcessorOptions): Promise<void> {
    this.graph?.destroy();
    await this.init(options);
  }

  async destroy(): Promise<void> {
    this.graph?.destroy();
    this.graph = undefined;
    this.processedTrack = undefined;
  }
}

export interface MicrophoneTestOptions {
  deviceId: string | null;
  outputDeviceId: string | null;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  percent: number;
}

/** The microphone opened on its own, to show its level and, if asked, to play it back: "test my microphone" in Settings. */
export interface MicrophoneTest {
  peak: () => number;
  setGain: (percent: number) => void;
  /** Plays what is sent back to the person: off by default, since without headphones it feeds back. */
  setLoopback: (on: boolean) => void;
  stop: () => void;
}

export async function startMicrophoneTest(options: MicrophoneTestOptions): Promise<MicrophoneTest> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: options.deviceId ? { exact: options.deviceId } : undefined,
      echoCancellation: options.echoCancellation,
      noiseSuppression: options.noiseSuppression,
      autoGainControl: options.autoGainControl,
    },
  });
  const context = new AudioContext();
  const graph = buildLevelGraph(context, stream.getAudioTracks()[0], options.percent);
  const element = document.createElement("audio");
  element.srcObject = new MediaStream([graph.output]);
  if (options.outputDeviceId) void (element as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId?.(options.outputDeviceId).catch(() => undefined);

  return {
    peak: graph.peak,
    setGain: graph.setGain,
    setLoopback: (on) => {
      if (on) void element.play().catch(() => undefined);
      else element.pause();
    },
    stop: () => {
      element.pause();
      element.srcObject = null;
      graph.destroy();
      stream.getTracks().forEach((track) => track.stop());
      void context.close().catch(() => undefined);
    },
  };
}
