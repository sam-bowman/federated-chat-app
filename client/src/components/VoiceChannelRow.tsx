import type { Channel, Community } from "../api";
import { useAuth } from "../context/AuthContext";
import { useVoice } from "../context/VoiceContext";
import { domainOf } from "../lib/permissions";
import Button from "./Button";
import VoiceParticipants from "./VoiceParticipants";

/**
 * A voice channel in the sidebar: pressing it joins the call (and pressing it again leaves), and under it are the people in it
 * right now, which anyone in the community can see without joining. In the call you are in, whoever is speaking is outlined and
 * whoever has their microphone off says so.
 */
export default function VoiceChannelRow({ channel, community }: { channel: Channel; community: Community }) {
  const voice = useVoice();
  const { user } = useAuth();
  if (!user) return null;

  const here = voice.session?.channelId === channel.id;
  const onAnotherServer = community.homeserverDomain.toLowerCase() !== domainOf(user.identity);
  const joinable = !onAnotherServer && voice.voiceAvailable(community.id);
  const ids = voice.people[channel.id] ?? [];
  const members = new Map(community.members.map((m) => [m.id, m]));
  const inChannel = ids.map((id) => members.get(id)).filter((m): m is NonNullable<typeof m> => !!m);

  const title = onAnotherServer
    ? "Voice channels can't be joined from another server yet."
    : !joinable
      ? "Voice isn't available right now."
      : here
        ? "Leave this voice channel"
        : "Join this voice channel";

  return (
    <div className="voice-channel">
      <Button
        variant="ghost"
        className={`sidebar-row voice-channel-button${here ? " active" : ""}`}
        disabled={!joinable && !here}
        title={title}
        aria-label={`${here ? "Leave" : "Join"} voice channel ${channel.name}`}
        onClick={() => (here ? voice.leave() : void voice.join({ id: channel.id, communityId: community.id }))}
      >
        <span className="voice-channel-name">🔊 {channel.name}</span>
        {inChannel.length > 0 && <span className="voice-count">{inChannel.length}</span>}
      </Button>
      <VoiceParticipants people={inChannel} label={`In ${channel.name}`} here={here} />
    </div>
  );
}
