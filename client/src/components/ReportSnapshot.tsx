import type { ReportSnapshot as Snapshot } from "../api";

/** One labelled line, skipped when there is nothing to say. */
function Line({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="report-snapshot-line">
      <span className="report-snapshot-label">{label}</span> <span className="report-snapshot-value">{value}</span>
    </div>
  );
}

const who = (person: { identity: string | null; displayName: string | null } | undefined) =>
  person ? [person.displayName, person.identity ? `(${person.identity})` : null].filter(Boolean).join(" ") : null;

/**
 * What was reported, as it was when it was reported (#58). All of it is a stranger's words, so every piece is drawn as text: no links, no
 * pictures, no markup. An attachment is shown as its address, which a moderator can read and decide whether to open.
 */
export default function ReportSnapshot({ snapshot }: { snapshot: Snapshot }) {
  if (snapshot.type === "erased") {
    return <p className="hint">The person this was about has since deleted their account, so what they wrote is no longer kept.</p>;
  }

  if (snapshot.type === "message") {
    const where = snapshot.where?.conversation
      ? snapshot.where.conversation === "direct"
        ? "A direct conversation"
        : "A group conversation"
      : [snapshot.where?.channel ? `# ${snapshot.where.channel}` : null, snapshot.where?.community].filter(Boolean).join(" in ");
    return (
      <div className="report-snapshot">
        {snapshot.text ? <blockquote className="report-snapshot-text">{snapshot.text}</blockquote> : <p className="hint">The message had no text.</p>}
        {(snapshot.attachmentCount ?? 0) > 0 && (
          <div className="report-snapshot-line">
            <span className="report-snapshot-label">
              {snapshot.attachmentCount === 1 ? "1 attachment" : `${snapshot.attachmentCount} attachments`}
            </span>
            <ul className="report-snapshot-files">
              {(snapshot.attachments ?? []).map((url) => (
                <li key={url}>{url}</li>
              ))}
            </ul>
            {(snapshot.attachmentCount ?? 0) > (snapshot.attachments?.length ?? 0) && <span className="hint">Only the first {snapshot.attachments?.length} are shown.</span>}
          </div>
        )}
        <Line label="Sent by" value={who(snapshot.sender)} />
        <Line label="Where" value={where} />
        <Line label="Sent" value={snapshot.sentAt ? new Date(snapshot.sentAt).toLocaleString() : null} />
        <Line label="Edited" value={snapshot.editedAt ? new Date(snapshot.editedAt).toLocaleString() : null} />
      </div>
    );
  }

  if (snapshot.type === "user") {
    return (
      <div className="report-snapshot">
        <Line label="Person" value={who({ identity: snapshot.identity ?? null, displayName: snapshot.displayName ?? null })} />
        <Line label="Bio" value={snapshot.bio} />
        <Line label="Pronouns" value={snapshot.pronouns} />
        <Line label="Status" value={snapshot.customStatus} />
      </div>
    );
  }

  return (
    <div className="report-snapshot">
      <Line label="Community" value={snapshot.name} />
      <Line label="Description" value={snapshot.description} />
      <Line label="Icon text" value={snapshot.iconText} />
      <Line label="Owner" value={who(snapshot.owner)} />
    </div>
  );
}
