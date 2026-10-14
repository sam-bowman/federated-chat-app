import { useState } from "react";
import type { Community } from "../api";
import DeleteCommunityModal from "./DeleteCommunityModal";
import TransferOwnerModal from "./TransferOwnerModal";

interface Props {
  community: Community;
  viewer: { id: string; identity: string };
  /** Closes the whole settings dialog: once ownership moves or the community is gone, it no longer applies. */
  onFinished: () => void;
}

/**
 * The two ways out of owning a community. Shown only to the owner - never by permission, so a delegated
 * manager who can open Settings does not see it.
 */
export default function CommunityDangerZone({ community, viewer, onFinished }: Props) {
  const [dialog, setDialog] = useState<"transfer" | "delete" | null>(null);
  if (community.owner.id !== viewer.id) return null;

  return (
    <section
      aria-label="Danger zone"
      style={{ marginTop: 22, paddingTop: 14, borderTop: "1px solid var(--danger)", display: "flex", flexDirection: "column", gap: 10 }}
    >
      <h3 style={{ margin: 0, color: "var(--danger)" }}>Danger zone</h3>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <span className="hint">Hand this community to another member, then leave or stay on as a regular member.</span>
        <button type="button" className="btn-secondary" onClick={() => setDialog("transfer")}>
          Transfer ownership…
        </button>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <span className="hint">Permanently delete this community and everything in it.</span>
        <button type="button" className="btn-danger" onClick={() => setDialog("delete")}>
          Delete community…
        </button>
      </div>

      {dialog === "transfer" && (
        <TransferOwnerModal
          community={community}
          viewer={viewer}
          onClose={() => setDialog(null)}
          onTransferred={onFinished}
        />
      )}
      {dialog === "delete" && (
        <DeleteCommunityModal community={community} onClose={() => setDialog(null)} onDeleted={onFinished} />
      )}
    </section>
  );
}
