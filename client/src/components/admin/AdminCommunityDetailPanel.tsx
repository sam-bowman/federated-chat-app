import { useCallback, useEffect, useId, useState } from "react";
import * as api from "../../api";
import type { AdminCommunityDetail } from "../../api";
import { nameConfirmed } from "../../lib/adminCommunities";
import { adminErrorMessage } from "../../lib/adminText";
import { VISIBILITY_CHOICES } from "../../lib/communityVisibility";
import { noAutofill } from "../../lib/noAutofill";
import Button from "../Button";
import Modal from "../Modal";
import { SudoCancelled, useSudo } from "./SudoContext";

const when = (iso: string) => new Date(iso).toLocaleString();

type Dialog = "transfer" | "delete" | null;

/**
 * One community and what an admin can do about it (#206): hand it to another of its members, or delete it. Both go through sudo mode and are written to the
 * audit log by the server. What it shows is how big the community is and where its people are from: never its description, its channels' names or anything said in it.
 */
export default function AdminCommunityDetailPanel({ id, onChanged, onGone }: { id: string; onChanged: () => void; onGone: () => void }) {
  const sudo = useSudo();
  const [community, setCommunity] = useState<AdminCommunityDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);

  useEffect(() => {
    let current = true;
    api
      .getAdminCommunity(id)
      .then((r) => current && setCommunity(r.community))
      .catch((err) => current && setLoadError(adminErrorMessage(err)));
    return () => {
      current = false;
    };
  }, [id]);

  /** Does one action in sudo mode and shows the result: the community as it is now, or an explanation. A confirmation they back out of is not an error. */
  const act = useCallback(
    async (action: (sudoToken: string) => Promise<{ community: AdminCommunityDetail } | { deleted: true }>) => {
      setBusy(true);
      setError(null);
      try {
        const result = await sudo.run(action);
        if ("deleted" in result) {
          onGone();
          return;
        }
        setCommunity(result.community);
        onChanged();
      } catch (err) {
        if (!(err instanceof SudoCancelled)) setError(adminErrorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [sudo, onChanged, onGone]
  );

  if (loadError) return <p className="error-text">{loadError}</p>;
  if (!community) return <p className="hint">Loading…</p>;

  const joins = VISIBILITY_CHOICES.find((choice) => choice.value === community.visibility)?.label ?? community.visibility;
  return (
    <section className="admin-user" aria-label={`Community ${community.name}`}>
      <h4>{community.name}</h4>

      <dl className="admin-user-facts">
        <dt>Owner</dt>
        <dd>{community.owner}</dd>
        <dt>Members</dt>
        <dd>
          {community.members}: {community.localMembers} on this server, {community.remoteMembers} on other servers
          {community.remoteDomains.length > 0 && ` (${community.remoteDomains.join(", ")})`}
        </dd>
        <dt>Channels</dt>
        <dd>
          {community.textChannels} text, {community.voiceChannels} voice
        </dd>
        <dt>Who can join</dt>
        <dd>{joins}</dd>
        <dt>Made</dt>
        <dd>{when(community.createdAt)}</dd>
      </dl>

      {error && <p className="error-text">{error}</p>}

      <div className="admin-user-actions">
        <Button type="button" variant="secondary" busy={busy} onClick={() => setDialog("transfer")}>
          Hand to another member…
        </Button>
        <Button type="button" variant="danger" busy={busy} onClick={() => setDialog("delete")}>
          Delete…
        </Button>
      </div>

      {dialog === "transfer" && (
        <TransferDialog community={community} onClose={() => setDialog(null)} onSubmit={(username) => void act((t) => api.adminTransferCommunity(community.id, username, t))} />
      )}
      {dialog === "delete" && (
        <DeleteDialog community={community} onClose={() => setDialog(null)} onSubmit={(typed) => void act((t) => api.adminDeleteCommunity(community.id, typed, t))} />
      )}
    </section>
  );
}

function TransferDialog({ community, onSubmit, onClose }: { community: AdminCommunityDetail; onSubmit: (username: string) => void; onClose: () => void }) {
  const fieldId = useId();
  const [typed, setTyped] = useState("");
  const ready = typed.trim() !== "";
  return (
    <Modal title={`Hand ${community.name} to another member`} onClose={onClose}>
      <form
        className="data-export-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          onSubmit(typed.trim());
          onClose();
        }}
      >
        <p className="hint">
          The new owner has to be a member of this community with an account on this server, and not suspended. Everyone in the community is told. {community.owner} stays a member and
          keeps everything else about their account. Use it when the owner cannot or will not do it themselves, for instance an account that is being closed.
        </p>
        <label htmlFor={fieldId}>Username of the new owner</label>
        <input id={fieldId} type="text" {...noAutofill} autoCapitalize="none" spellCheck={false} autoFocus placeholder="their username here, without the server" value={typed} onChange={(e) => setTyped(e.target.value)} />
        <div className="data-export-form-buttons">
          <Button type="submit" disabled={!ready}>
            Hand it over
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteDialog({ community, onSubmit, onClose }: { community: AdminCommunityDetail; onSubmit: (typed: string) => void; onClose: () => void }) {
  const fieldId = useId();
  const [typed, setTyped] = useState("");
  const ready = nameConfirmed(typed, community.name);
  return (
    <Modal title={`Delete ${community.name}`} onClose={onClose}>
      <form
        className="data-export-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          onSubmit(typed);
          onClose();
        }}
      >
        <p className="hint">
          Its channels, messages, roles, memberships and emoticons are removed for good, every member is told, other servers drop their copy and its voice rooms are closed.
          This cannot be undone, and the owner is not asked.
        </p>
        <label htmlFor={fieldId}>
          Type its name, <strong>{community.name}</strong>, to confirm
        </label>
        <input id={fieldId} type="text" {...noAutofill} autoCapitalize="none" spellCheck={false} autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
        <div className="data-export-form-buttons">
          <Button type="submit" variant="danger" disabled={!ready}>
            Delete for good
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}
