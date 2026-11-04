/**
 * The small "BOT" mark beside a name (#132): the account is a program, not a person, and nobody should have to guess. Draws nothing for a
 * person (or for an older server that does not say), so it can be put beside every name without a check at each place.
 */
export default function BotBadge({ user }: { user: { isBot?: boolean } }) {
  if (!user.isBot) return null;
  return (
    <span className="bot-badge" title="This account is a bot, a program rather than a person">
      Bot
    </span>
  );
}
