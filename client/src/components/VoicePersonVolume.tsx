import { useState } from "react";
import { useVoice } from "../context/VoiceContext";
import { DEFAULT_PERCENT, personOf } from "../lib/voiceAudio";
import Button from "./Button";
import VolumeSlider from "./VolumeSlider";

/**
 * How loud one person in the call is, for this person only: a volume from 0% to 200% and a mute. Nothing here is sent to anyone: it
 * changes nothing for the other person or for anyone else listening. Remembered by their full identity, so it applies in every call.
 */
export default function VoicePersonVolume({ identity, name }: { identity: string; name: string }) {
  const voice = useVoice();
  const [open, setOpen] = useState(false);
  const setting = personOf(voice.audio, identity);
  const changed = setting.muted || setting.volume !== DEFAULT_PERCENT;
  const summary = setting.muted ? "muted for you" : `${setting.volume}%`;

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="voice-person-volume-button"
        aria-label={`Volume for ${name}`}
        aria-expanded={open}
        title={changed ? `${name} is ${summary}` : `Change how loud ${name} is for you`}
        onClick={() => setOpen(!open)}
      >
        {setting.muted ? "🔇" : "🔉"}
        {changed && !setting.muted ? ` ${setting.volume}%` : ""}
      </Button>
      {open && (
        <div className="voice-person-volume" role="group" aria-label={`Volume for ${name}`}>
          <VolumeSlider label={`${name}'s volume`} value={setting.volume} onChange={(volume) => voice.setPerson(identity, { volume })} />
          <label className="remember-option">
            <input type="checkbox" checked={setting.muted} onChange={(e) => voice.setPerson(identity, { muted: e.target.checked })} />
            Mute for me
          </label>
          <p className="hint">Only you hear this change.</p>
        </div>
      )}
    </>
  );
}
