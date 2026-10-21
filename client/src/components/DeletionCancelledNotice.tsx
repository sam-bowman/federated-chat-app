import { dismissDeletionCancelled, useDeletionCancelled } from "../lib/deletionNotice";
import Button from "./Button";

/** Shown after the sign-in that cancelled a request to delete the account, so nobody is left wondering what happened to it. */
export default function DeletionCancelledNotice() {
  const cancelled = useDeletionCancelled();
  if (!cancelled) return null;
  return (
    <div className="update-banner" role="status">
      <span>You asked for this account to be deleted. Signing in cancelled that, and nothing was erased.</span>
      <Button type="button" size="sm" variant="secondary" onClick={dismissDeletionCancelled}>
        OK
      </Button>
    </div>
  );
}
