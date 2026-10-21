import { useId, useState } from "react";
import { useVoice } from "../context/VoiceContext";
import Button from "./Button";
import CallQualityReadout from "./CallQualityReadout";
import VolumeSlider from "./VolumeSlider";

const STATUS: Record<"connecting" | "connected" | "reconnecting", string> = {
  connecting: "Connecting…",
  connected: "Voice connected",
  reconnecting: "Reconnecting…",
};

/**
 * The call you are in, at the bottom of the sidebar wherever you go in the app: which channel, mute, deafen, leave and the choice of
 * microphone and speaker. Also where a call that ended (or could not start) says why.
 */
export default function VoicePanel() {
  const voice = useVoice();
  const { session, notice, devices } = voice;
  const [showDevices, setShowDevices] = useState(false);
  const [showQuality, setShowQuality] = useState(false);
  const micId = useId();
  const speakerId = useId();

  if (!session && !notice) return null;

  function toggleDevices() {
    if (!showDevices) void voice.refreshDevices();
    setShowDevices(!showDevices);
  }

  return (
    <div className="voice-panel" role="region" aria-label="Voice call">
      {notice && (
        <div className="voice-notice" role="status">
          <span>{notice}</span>
          <Button variant="secondary" size="sm" onClick={voice.dismissNotice}>
            Dismiss
          </Button>
        </div>
      )}
      {session && (
        <>
          <div className="voice-panel-title" role="status">
            <strong>{STATUS[session.status]}</strong>
            <span className="hint">
              🔊 {session.channelName}
              {session.communityName ? ` / ${session.communityName}` : ""}
            </span>
          </div>
          {session.micProblem && <p className="hint voice-problem">{session.micProblem}</p>}
          {session.audioBlocked && (
            <Button variant="secondary" size="sm" onClick={() => void voice.allowAudio()}>
              Click to hear the call
            </Button>
          )}
          <div className="voice-panel-buttons">
            <Button
              variant={session.muted ? "danger" : "secondary"}
              size="sm"
              aria-pressed={session.muted}
              onClick={() => void voice.setMuted(!session.muted)}
            >
              {session.muted ? "Unmute" : "Mute"}
            </Button>
            <Button variant={session.deafened ? "danger" : "secondary"} size="sm" aria-pressed={session.deafened} onClick={() => voice.setDeafened(!session.deafened)}>
              {session.deafened ? "Undeafen" : "Deafen"}
            </Button>
            <Button variant="secondary" size="sm" aria-expanded={showDevices} onClick={toggleDevices}>
              Devices
            </Button>
            <Button variant="secondary" size="sm" aria-expanded={showQuality} onClick={() => setShowQuality(!showQuality)}>
              Quality
            </Button>
            <Button variant="danger" size="sm" onClick={voice.leave}>
              Leave
            </Button>
          </div>
          {showQuality && <CallQualityReadout />}
          {showDevices && (
            <div className="voice-devices">
              <label htmlFor={micId}>Microphone</label>
              <select id={micId} value={devices.prefs.input ?? ""} onChange={(e) => void voice.chooseInput(e.target.value || null)}>
                <option value="">System default</option>
                {devices.inputs.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
              <label htmlFor={speakerId}>Speaker</label>
              <select id={speakerId} value={devices.prefs.output ?? ""} onChange={(e) => void voice.chooseOutput(e.target.value || null)}>
                <option value="">System default</option>
                {devices.outputs.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
              <VolumeSlider label="Your microphone volume" value={voice.audio.inputVolume} onChange={voice.setInputVolume} />
              <VolumeSlider label="Everyone's volume" value={voice.audio.outputVolume} onChange={voice.setOutputVolume} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
