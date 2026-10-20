import type { PublicUser } from "../api";
import { useAuth } from "../context/AuthContext";
import { useVoice } from "../context/VoiceContext";
import Avatar from "./Avatar";
import VoicePersonVolume from "./VoicePersonVolume";

/**
 * The people in a call, as a list: in the call you are in, whoever is speaking is outlined, whoever has their microphone off says
 * so, and everyone else has a volume control that only you hear. Used under a voice channel and in a conversation's call.
 */
export default function VoiceParticipants({ people, label, here }: { people: PublicUser[]; label: string; here: boolean }) {
  const voice = useVoice();
  const { user } = useAuth();
  if (!user || people.length === 0) return null;
  return (
    <ul className="voice-people" aria-label={label}>
      {people.map((member) => {
        const speaking = here && voice.speaking.has(member.id);
        const micOff = here && (member.id === user.id ? !!voice.session?.muted : voice.micOff.has(member.id));
        return (
          <li key={member.id} className={`voice-person${speaking ? " speaking" : ""}`}>
            <Avatar user={member} size="sm" />
            <span className="voice-person-name">{member.displayName}</span>
            {speaking && <span className="sr-only"> (speaking)</span>}
            {micOff && (
              <span role="img" aria-label="microphone off" title="Microphone off">
                🔇
              </span>
            )}
            {here && member.id !== user.id && <VoicePersonVolume identity={member.identity} name={member.displayName} />}
          </li>
        );
      })}
    </ul>
  );
}
