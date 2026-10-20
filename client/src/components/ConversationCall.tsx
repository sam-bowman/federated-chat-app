import type { Conversation } from "../api";
import { useAuth } from "../context/AuthContext";
import { useVoice } from "../context/VoiceContext";
import { canCallConversation } from "../lib/voiceCalls";
import Button from "./Button";
import VoiceParticipants from "./VoiceParticipants";

/**
 * The call button in a conversation's header: start a call, join one somebody has started, or leave the one you are in. Shown only on
 * a server with voice. A conversation with somebody on another server cannot be called yet (its voice server is theirs), and says
 * so on the button rather than leaving it out.
 */
export function ConversationCallButton({ conversation }: { conversation: Conversation }) {
  const voice = useVoice();
  const { user } = useAuth();
  if (!user || !voice.callsOffered) return null;

  const here = voice.session?.channelId === conversation.id;
  const going = (voice.people[conversation.id] ?? []).length > 0;
  const callable = canCallConversation(conversation, user.identity);
  const label = here ? "Leave call" : going ? "Join call" : "Start call";
  const unavailable = !callable ? "Calls with people on other servers aren't available yet." : !voice.callsAvailable ? "Calls aren't available right now." : null;

  return (
    <Button
      variant={here ? "danger" : "secondary"}
      size="sm"
      disabled={!!unavailable && !here}
      title={unavailable ?? (here ? "Leave this call" : going ? "Join the call in this chat" : "Start a voice call in this chat")}
      aria-label={label}
      aria-pressed={here}
      onClick={() => (here ? voice.leave() : void voice.joinCall(conversation.id))}
    >
      📞 {label}
    </Button>
  );
}

/** Who is in the conversation's call right now, under its header, for anyone in the conversation to see. */
export function ConversationCallPeople({ conversation }: { conversation: Conversation }) {
  const voice = useVoice();
  const ids = voice.people[conversation.id] ?? [];
  if (ids.length === 0) return null;
  const members = new Map(conversation.members.map((m) => [m.id, m]));
  const people = ids.map((id) => members.get(id)).filter((m): m is NonNullable<typeof m> => !!m);
  return (
    <div className="conversation-call">
      <span className="hint">In the call:</span>
      <VoiceParticipants people={people} label="In the call" here={voice.session?.channelId === conversation.id} />
    </div>
  );
}
