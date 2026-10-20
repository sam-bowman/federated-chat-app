import { useEffect, useId, useRef, useState } from "react";
import { useVoice } from "../context/VoiceContext";
import { CLIP_LEVEL, startMicrophoneTest, type MicrophoneTest } from "../lib/micLevel";
import { DEFAULT_PERCENT, isDefaultPerson } from "../lib/voiceAudio";
import { microphoneMessage } from "../lib/voiceMessages";
import Button from "./Button";
import VolumeSlider from "./VolumeSlider";

/** How long "too loud" stays up after the last clipped moment, so a flicker can be read. */
const CLIP_HOLD_MS = 1500;

/**
 * Settings -> Voice & audio: which microphone and speaker, how loud your microphone is for everyone (with a meter that warns before
 * it clips, and a test that plays you back), the browser's own processing, how loud everyone is for you, and the people you have
 * turned up, down or off. Everything is remembered on this device and applies to the call you are in as you change it.
 */
export default function VoiceSettingsSection() {
  const voice = useVoice();
  const { audio, devices } = voice;
  const micId = useId();
  const speakerId = useId();
  const [testing, setTesting] = useState(false);
  const [hearMyself, setHearMyself] = useState(false);
  const [level, setLevel] = useState(0);
  const [clipping, setClipping] = useState(false);
  const [testProblem, setTestProblem] = useState<string | null>(null);
  const test = useRef<MicrophoneTest | null>(null);
  const hearRef = useRef(hearMyself);
  hearRef.current = hearMyself;

  useEffect(() => {
    void voice.refreshDevices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The test: the microphone opened on its own, read many times a second for the meter. It starts again when something that
  // changes what is heard changes (the microphone, the processing), and always stops when this page does.
  useEffect(() => {
    if (!testing) return;
    let frame = 0;
    let clippedAt = 0;
    let stopped = false;
    setTestProblem(null);
    startMicrophoneTest({
      deviceId: devices.prefs.input,
      outputDeviceId: devices.prefs.output,
      echoCancellation: audio.echoCancellation,
      noiseSuppression: audio.noiseSuppression,
      autoGainControl: audio.autoGainControl,
      percent: audio.inputVolume,
    })
      .then((started) => {
        if (stopped) {
          started.stop();
          return;
        }
        test.current = started;
        started.setLoopback(hearRef.current);
        const read = () => {
          const peak = started.peak();
          setLevel(peak);
          if (peak >= CLIP_LEVEL) clippedAt = performance.now();
          setClipping(performance.now() - clippedAt < CLIP_HOLD_MS && clippedAt > 0);
          frame = requestAnimationFrame(read);
        };
        read();
      })
      .catch((err) => {
        setTesting(false);
        setTestProblem(microphoneMessage(err));
      });
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      test.current?.stop();
      test.current = null;
      setLevel(0);
      setClipping(false);
    };
  }, [testing, devices.prefs.input, devices.prefs.output, audio.echoCancellation, audio.noiseSuppression, audio.autoGainControl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Moving the slider is heard in the test at once.
  useEffect(() => {
    test.current?.setGain(audio.inputVolume);
  }, [audio.inputVolume]);
  useEffect(() => {
    test.current?.setLoopback(hearMyself);
  }, [hearMyself]);

  const adjusted = Object.entries(audio.people).filter(([, person]) => !isDefaultPerson(person));
  const percent = Math.min(100, Math.round(level * 100));

  return (
    <>
      <h3>Voice &amp; audio</h3>
      <p className="hint">How you sound and how others sound to you in voice channels. Kept on this device; changes apply to the call you are in.</p>

      <h4 className="notification-heading">What you send</h4>
      <div className="voice-setting">
        <label htmlFor={micId}>Microphone</label>
        <select id={micId} value={devices.prefs.input ?? ""} onChange={(e) => void voice.chooseInput(e.target.value || null)}>
          <option value="">System default</option>
          {devices.inputs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      </div>

      <VolumeSlider label="Input volume" value={audio.inputVolume} onChange={voice.setInputVolume} />
      <p className="hint">
        How loud your microphone is for everyone in the call. Turn it up if people say you are quiet; above 100% is a boost, and a limiter keeps
        it from distorting.
      </p>

      <div className="voice-meter-row">
        <div
          className={`voice-meter${clipping ? " clipping" : ""}`}
          role="meter"
          aria-label="Microphone level"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          style={{ "--level": `${percent}%` } as React.CSSProperties}
        >
          <div className="voice-meter-bar" />
        </div>
        <Button variant="secondary" size="sm" aria-pressed={testing} onClick={() => setTesting(!testing)}>
          {testing ? "Stop testing" : "Test my microphone"}
        </Button>
      </div>
      {clipping && (
        <p className="error-text" role="status">
          Too loud: the sound is being clipped. Turn the input volume down.
        </p>
      )}
      {testProblem && <p className="error-text">{testProblem}</p>}
      <label className="remember-option">
        <input type="checkbox" checked={hearMyself} onChange={(e) => setHearMyself(e.target.checked)} />
        Hear myself while testing (use headphones, or it feeds back)
      </label>

      <label className="remember-option">
        <input type="checkbox" checked={audio.echoCancellation} onChange={(e) => void voice.setProcessing("echoCancellation", e.target.checked)} />
        Echo cancellation
      </label>
      <label className="remember-option">
        <input type="checkbox" checked={audio.noiseSuppression} onChange={(e) => void voice.setProcessing("noiseSuppression", e.target.checked)} />
        Noise suppression
      </label>
      <label className="remember-option">
        <input type="checkbox" checked={audio.autoGainControl} onChange={(e) => void voice.setProcessing("autoGainControl", e.target.checked)} />
        Automatic gain (the browser keeps your volume even by itself)
      </label>
      {audio.autoGainControl && audio.inputVolume !== DEFAULT_PERCENT && (
        <p className="hint" role="status">
          Automatic gain adjusts your volume by itself, which works against the input volume you set. Turn it off to set the volume yourself.
        </p>
      )}

      <h4 className="notification-heading">What you hear</h4>
      <div className="voice-setting">
        <label htmlFor={speakerId}>Speaker</label>
        <select id={speakerId} value={devices.prefs.output ?? ""} onChange={(e) => void voice.chooseOutput(e.target.value || null)}>
          <option value="">System default</option>
          {devices.outputs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      </div>
      <VolumeSlider label="Master volume" value={audio.outputVolume} onChange={voice.setOutputVolume} />
      <p className="hint">How loud everyone in a call is for you. To change one person, use the volume button next to them in the call.</p>

      <h4 className="notification-heading">People you have adjusted</h4>
      {adjusted.length === 0 ? (
        <p className="hint">Nobody: everyone is at 100%. Only you ever hear these changes.</p>
      ) : (
        <>
          <ul className="notification-overrides">
            {adjusted.map(([identity, person]) => (
              <li key={identity}>
                <span className="notification-override-name">{identity}</span>
                <span className="hint">{person.muted ? "Muted for you" : `${person.volume}%`}</span>
                <Button variant="secondary" size="sm" aria-label={`Put ${identity} back to 100%`} onClick={() => voice.setPerson(identity, { volume: DEFAULT_PERCENT, muted: false })}>
                  Reset
                </Button>
              </li>
            ))}
          </ul>
          <Button variant="secondary" size="sm" onClick={voice.resetPeople}>
            Reset everyone
          </Button>
        </>
      )}
    </>
  );
}
