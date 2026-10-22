import { useEffect, useState } from "react";
import * as api from "../../api";
import type { AdminOverview as Overview } from "../../api";
import { SETTING_LABELS, agoInWords, attentionItems, settingValueInWords } from "../../lib/adminOverview";
import { VISIBILITY_CHOICES } from "../../lib/communityVisibility";
import Button from "../Button";

const onOff = (on: boolean) => (on ? "On" : "Off");
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The server at a glance (#206): what it is, how it is set up and how busy it is. Counts and switches only, from the server: never a message, a name
 * or a secret. It changes nothing (so it never asks to confirm it is you) and does not update by itself: it says when it was made, and Refresh makes it again.
 */
export default function AdminOverview() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  // One question at a time: Refresh cannot be pressed while one is on its way, so no answer can arrive after a newer one.
  useEffect(() => {
    api
      .getAdminOverview()
      .then((result) => {
        setOverview(result.overview);
        setError(null);
      })
      .catch(() => setError("Couldn't load the overview. Try again."))
      .finally(() => setLoading(false));
  }, [reload]);

  if (!overview) {
    return error ? (
      <>
        <p className="error-text">{error}</p>
        <Button type="button" variant="secondary" onClick={() => setReload((n) => n + 1)}>
          Try again
        </Button>
      </>
    ) : (
      <p className="hint">Loading…</p>
    );
  }

  const now = new Date(overview.generatedAt);
  const { server, registration, features, federation, people, communities } = overview;
  const attention = attentionItems(overview, now);
  const queue = federation.queue;
  const nothingWaiting = queue.pending === 0 && queue.inProgress === 0;

  return (
    <div className="admin-overview">
      {attention.length > 0 && (
        <section className="admin-overview-card admin-overview-attention" aria-label="Worth a look">
          <h4>Worth a look</h4>
          <ul>
            {attention.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="admin-overview-card" aria-label="Server">
        <h4>Server</h4>
        <dl className="admin-user-facts">
          <dt>Name</dt>
          <dd>{server.name}</dd>
          <dt>Domain</dt>
          <dd>{server.domain}</dd>
          <dt>Version</dt>
          <dd>{server.version}</dd>
          <dt>Files kept</dt>
          <dd>{server.storage === "s3" ? "In S3 storage" : "On the server's disk"}</dd>
          <dt>Realtime</dt>
          <dd>{server.redis ? "Shared between replicas (Redis)" : "This process only"}</dd>
        </dl>
      </section>

      <section className="admin-overview-card" aria-label="People">
        <h4>People</h4>
        <dl className="admin-user-facts">
          <dt>Accounts</dt>
          <dd>{people.total}</dd>
          <dt>Seen lately</dt>
          <dd>
            {people.activeLastDay} in the last day, {people.activeLastWeek} in the last week, {people.activeLastMonth} in the last month
          </dd>
          <dt>Joined in the last week</dt>
          <dd>{people.joinedLastWeek}</dd>
          <dt>Admins</dt>
          <dd>{people.admins}</dd>
          <dt>Suspended</dt>
          <dd>{people.suspended}</dd>
          <dt>Being deleted</dt>
          <dd>{people.deletionPending}</dd>
          <dt>Without two-factor</dt>
          <dd>{people.withoutTwoFactor}</dd>
        </dl>
      </section>

      <section className="admin-overview-card" aria-label="Communities">
        <h4>Communities</h4>
        <dl className="admin-user-facts">
          <dt>Hosted here</dt>
          <dd>{communities.hosted}</dd>
          <dt>Memberships</dt>
          <dd>{communities.memberships}</dd>
          <dt>Channels</dt>
          <dd>
            {communities.textChannels} text, {communities.voiceChannels} voice
          </dd>
          {VISIBILITY_CHOICES.map((choice) => (
            <div key={choice.value} className="admin-overview-pair">
              <dt>{choice.label}</dt>
              <dd>{communities.byVisibility[choice.value]}</dd>
            </div>
          ))}
          <dt>Copies of communities on other servers</dt>
          <dd>{communities.copiesOfOthers}</dd>
        </dl>
      </section>

      <section className="admin-overview-card" aria-label="Registration">
        <h4>Registration</h4>
        <dl className="admin-user-facts">
          <dt>Who can register</dt>
          <dd>{!registration.enabled ? "Nobody: registration is off" : registration.inviteOnly ? "Only people with an invite code" : "Anyone"}</dd>
          {registration.enabled && registration.inviteOnly && (
            <>
              <dt>Invite codes</dt>
              <dd>{registration.activeInvites === 0 ? "None can be used: nobody can register" : `${count(registration.activeInvites, "code")} can still be used`}</dd>
            </>
          )}
        </dl>
      </section>

      <section className="admin-overview-card" aria-label="Other servers">
        <h4>Other servers</h4>
        <dl className="admin-user-facts">
          <dt>Federation</dt>
          <dd>{federation.enabled ? "On" : "Off: this server is private"}</dd>
          {federation.enabled && (
            <>
              <dt>Talks to</dt>
              <dd>
                {federation.allowedServers > 0
                  ? `Only ${count(federation.allowedServers, "server")} on its allow list`
                  : federation.blockedServers > 0
                    ? `Every server except ${count(federation.blockedServers, "blocked one")}`
                    : "Any server"}
              </dd>
            </>
          )}
          <dt>Servers it knows</dt>
          <dd>{federation.knownServers}</dd>
          <dt>Waiting to be sent</dt>
          <dd>
            {nothingWaiting
              ? "Nothing"
              : `${queue.pending} (${queue.retrying} being retried${queue.oldestPendingAt ? `, the oldest from ${agoInWords(queue.oldestPendingAt, now)}` : ""})${queue.inProgress > 0 ? `, ${queue.inProgress} being sent now` : ""}`}
          </dd>
          <dt>Gave up on</dt>
          <dd>{queue.failed}</dd>
        </dl>
      </section>

      <section className="admin-overview-card" aria-label="Features">
        <h4>Features</h4>
        <dl className="admin-user-facts">
          <dt>Voice channels</dt>
          <dd>{onOff(features.voice)}</dd>
          <dt>Public directory</dt>
          <dd>{onOff(features.directory)}</dd>
          <dt>Link previews</dt>
          <dd>{onOff(features.linkPreviews)}</dd>
          <dt>Audit log</dt>
          <dd>{count(overview.auditEntriesLastDay, "entry", "entries")} in the last day</dd>
        </dl>
      </section>

      <section className="admin-overview-card admin-overview-wide" aria-label="Settings in effect">
        <h4>Settings in effect</h4>
        <p className="hint">Read when the server starts: to change one, set it where the server is run and restart it.</p>
        <dl className="admin-user-facts">
          {overview.settings.map((item) => (
            <div key={item.setting} className="admin-overview-pair">
              <dt>
                {SETTING_LABELS[item.setting] ?? item.setting}
                <br />
                <code>{item.setting}</code>
              </dt>
              <dd>{settingValueInWords(item.setting, item.value)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="admin-overview-footer admin-overview-wide">
        <span className="hint" role="status">
          As of {now.toLocaleTimeString()}
        </span>
        <Button type="button" variant="secondary" size="sm" busy={loading} onClick={() => (setLoading(true), setReload((n) => n + 1))}>
          Refresh
        </Button>
        {error && <span className="error-text">{error}</span>}
      </div>
    </div>
  );
}
