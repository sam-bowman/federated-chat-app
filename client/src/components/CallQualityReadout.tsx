import { useEffect, useState } from "react";
import { useVoice } from "../context/VoiceContext";
import { summarizeCallQuality, type CallQuality, type QualityLevel } from "../lib/callQuality";

/** How often the numbers are read while the readout is open. */
const EVERY_MS = 2000;

const VERDICT: Record<QualityLevel, string> = {
  good: "Good",
  fair: "Fair",
  poor: "Poor",
  unknown: "Measuring…",
};

const ms = (value: number | null) => (value === null ? "–" : `${Math.round(value)} ms`);
const percent = (value: number | null) => (value === null ? "–" : `${value < 10 ? value.toFixed(1) : Math.round(value)}%`);

function connection(quality: CallQuality): string {
  if (!quality.transport) return "–";
  const way = quality.path === "relay" ? "through a relay" : quality.path === "direct" ? "direct" : "through your router";
  return quality.transport === "tcp" ? `TCP, ${way} (the audio ports are not reachable, which adds delay)` : `UDP, ${way}`;
}

/**
 * What the call is like right now, read from the browser's connection statistics every couple of seconds while it is open: the
 * delay you hear, the round trip to the voice server, how long audio waits before it plays, and loss, and what kind of
 * connection it is. For finding out why a call lags, and for someone helping to.
 */
export default function CallQualityReadout() {
  const voice = useVoice();
  const [quality, setQuality] = useState<CallQuality | null>(null);

  useEffect(() => {
    let live = true;
    const read = async () => {
      const sample = await voice.sampleCallStats().catch(() => null);
      if (live && sample) setQuality(summarizeCallQuality(sample.sent, sample.received));
    };
    void read();
    const every = setInterval(() => void read(), EVERY_MS);
    return () => {
      live = false;
      clearInterval(every);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const level = quality?.level ?? "unknown";
  return (
    <div className="call-quality" role="group" aria-label="Call quality">
      <p className={`call-quality-verdict ${level}`} role="status">
        {VERDICT[level]}
      </p>
      <dl>
        <dt>Delay (network and buffering)</dt>
        <dd>{ms(quality?.delayMs ?? null)}</dd>
        <dt>Round trip to the voice server</dt>
        <dd>{ms(quality?.roundTripMs ?? null)}</dd>
        <dt>Audio waits before playing</dt>
        <dd>{ms(quality?.bufferMs ?? null)}</dd>
        <dt>Jitter</dt>
        <dd>{ms(quality?.jitterMs ?? null)}</dd>
        <dt>Audio lost</dt>
        <dd>{percent(quality?.lossPercent ?? null)}</dd>
        <dt>Connection</dt>
        <dd>{quality ? connection(quality) : "–"}</dd>
      </dl>
      <p className="hint">Capture, encoding and your speakers add a little on top of the delay shown.</p>
    </div>
  );
}
