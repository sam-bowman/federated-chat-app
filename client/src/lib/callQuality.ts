// What a call is like right now, worked out from the browser's own connection statistics (RTCStatsReport entries). Pure: the
// context collects the raw entries, this turns them into the few numbers a person (or someone helping them) can use.

/** One entry of an RTCStatsReport: a bag of named values with a `type`. */
export type StatEntry = { type?: string; [name: string]: unknown };

export type QualityLevel = "good" | "fair" | "poor" | "unknown";

export interface CallQuality {
  /** Round trip to the voice server, ms. */
  roundTripMs: number | null;
  /** Variation in when the other people's audio arrives, ms (the worst of them). */
  jitterMs: number | null;
  /** How long incoming audio waits before it is played, ms: what grows when the connection is jittery. This is the delay you hear. */
  bufferMs: number | null;
  /** Incoming audio that never arrived, % (the worst of them). */
  lossPercent: number | null;
  /** UDP is what a call wants; TCP means the audio ports are blocked or not reachable, which adds delay. */
  transport: "udp" | "tcp" | null;
  /** direct: both ends on one network; nat: through a router, the usual case; relay: through a relay server. */
  path: "direct" | "nat" | "relay" | null;
  /** About how late you hear someone from the network and buffering alone: half the round trip plus the buffer. Capture, encoding and your speakers come on top. */
  delayMs: number | null;
  level: QualityLevel;
}

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const max = (values: (number | null)[]): number | null => {
  const found = values.filter((v): v is number => v !== null);
  return found.length > 0 ? Math.max(...found) : null;
};
const ofType = (entries: StatEntry[], type: string) => entries.filter((e) => e.type === type);
const audio = (entries: StatEntry[]) => entries.filter((e) => e.kind === "audio" || e.mediaType === "audio");

/** The candidate pair the connection is actually using, with what kind of path and transport it is. */
function selectedPath(entries: StatEntry[]): Pick<CallQuality, "transport" | "path"> & { rttMs: number | null } {
  const byId = new Map(entries.filter((e) => typeof e.id === "string").map((e) => [e.id as string, e]));
  const transport = ofType(entries, "transport").find((t) => typeof t.selectedCandidatePairId === "string");
  const pair =
    (transport && byId.get(transport.selectedCandidatePairId as string)) ??
    ofType(entries, "candidate-pair").find((p) => p.nominated === true && p.state === "succeeded") ??
    ofType(entries, "candidate-pair").find((p) => p.selected === true);
  if (!pair) return { transport: null, path: null, rttMs: null };
  const local = byId.get(pair.localCandidateId as string);
  const remote = byId.get(pair.remoteCandidateId as string);
  const protocol = String(local?.protocol ?? remote?.protocol ?? "").toLowerCase();
  const kinds = [local?.candidateType, remote?.candidateType].map(String);
  const path = kinds.includes("relay") ? "relay" : kinds.every((k) => k === "host") ? "direct" : "nat";
  const rtt = num(pair.currentRoundTripTime);
  return { transport: protocol === "udp" || protocol === "tcp" ? protocol : null, path: local || remote ? path : null, rttMs: rtt === null ? null : rtt * 1000 };
}

/**
 * `sent`: the statistics of the connection the microphone goes out on (null when there is none yet). `received`: one list per
 * person being heard. Anything that cannot be worked out yet (nobody else is in the call, so nothing is arriving) is null.
 */
export function summarizeCallQuality(sent: StatEntry[] | null, received: StatEntry[][]): CallQuality {
  const path = sent ? selectedPath(sent) : { transport: null, path: null, rttMs: null };
  const reported = sent ? audio(ofType(sent, "remote-inbound-rtp")).map((e) => num(e.roundTripTime)) : [];
  const fromReport = max(reported);
  const roundTripMs = fromReport !== null ? fromReport * 1000 : path.rttMs;

  const inbound = received.flatMap((entries) => audio(ofType(entries, "inbound-rtp")));
  const jitter = max(inbound.map((e) => num(e.jitter)));
  const buffers = inbound
    .map((e) => {
      const delay = num(e.jitterBufferDelay);
      const emitted = num(e.jitterBufferEmittedCount);
      return delay !== null && emitted !== null && emitted > 0 ? (delay / emitted) * 1000 : null;
    })
    .filter((v): v is number => v !== null);
  const loss = max(
    inbound.map((e) => {
      const lost = num(e.packetsLost);
      const got = num(e.packetsReceived);
      return lost !== null && got !== null && lost + got > 0 ? (Math.max(lost, 0) / (Math.max(lost, 0) + got)) * 100 : null;
    })
  );

  const bufferMs = buffers.length > 0 ? Math.max(...buffers) : null;
  const delayMs = roundTripMs === null ? null : roundTripMs / 2 + (bufferMs ?? 0);
  const jitterMs = jitter === null ? null : jitter * 1000;

  return { roundTripMs, jitterMs, bufferMs, lossPercent: loss, transport: path.transport, path: path.path, delayMs, level: levelOf(delayMs, loss, jitterMs, path.transport) };
}

/** Good, fair or poor, from the delay, loss and jitter: thresholds in the range voice calls are usually judged by. */
export function levelOf(delayMs: number | null, lossPercent: number | null, jitterMs: number | null, transport: "udp" | "tcp" | null): QualityLevel {
  if (delayMs === null) return "unknown";
  if (delayMs > 250 || (lossPercent ?? 0) > 8) return "poor";
  if (delayMs > 150 || (lossPercent ?? 0) > 2 || (jitterMs ?? 0) > 40 || transport === "tcp") return "fair";
  return "good";
}
