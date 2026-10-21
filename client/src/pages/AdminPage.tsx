import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import * as api from "../api";
import { ApiError } from "../api/client";
import AuditLogList from "../components/AuditLogList";
import Tabs from "../components/Tabs";

type State = { kind: "checking" } | { kind: "hidden" } | { kind: "needs-two-factor" } | { kind: "ready" } | { kind: "error" };
type Tab = "audit";

/**
 * The admin page (#206), at /admin. It is loaded only when someone goes there (App.tsx), and it asks the server whether the person is an admin
 * before showing anything: for anyone else the server answers 404 and this shows the same "not found" as any other address that is not
 * a page, so it gives away nothing about whether there is an admin page at all. What it shows is about the server and what was done to it:
 * never a message, a direct message or an attachment.
 */
export default function AdminPage() {
  const [state, setState] = useState<State>({ kind: "checking" });
  const [tab, setTab] = useState<Tab>("audit");

  useEffect(() => {
    let current = true;
    api
      .getAdminMe()
      .then((me) => current && setState(me.twoFactor ? { kind: "ready" } : { kind: "needs-two-factor" }))
      .catch((err) => current && setState(err instanceof ApiError && err.status === 404 ? { kind: "hidden" } : { kind: "error" }));
    return () => {
      current = false;
    };
  }, []);

  const loadAudit = useCallback((query: api.AuditQuery) => api.getAdminAuditLog(query), []);

  if (state.kind === "checking") return <div className="empty-state">Loading…</div>;
  if (state.kind === "hidden") return <div className="empty-state">Page not found.</div>;
  if (state.kind === "error") return <div className="empty-state">Couldn&apos;t reach the server. Try again.</div>;

  return (
    <>
      <div className="main-header">Server administration</div>
      <div className="panel" style={{ maxWidth: "53.75rem" }}>
        {state.kind === "needs-two-factor" ? (
          <>
            <h3>Turn on two-factor sign-in first</h3>
            <p className="hint">
              An admin can see and change things for everyone on this server, so the admin page only opens for an account with two-factor sign-in on.
              Turn it on in <Link to="/settings">Settings</Link>, then come back here.
            </p>
          </>
        ) : (
          <Tabs label="Administration" tabs={[{ id: "audit", label: "Audit log" }]} value={tab} onChange={setTab} minHeight="20rem">
            {tab === "audit" && (
              <>
                <p className="hint">Everything that was done: what moderators did in every community, and what operators did. It holds who and what, never what anyone wrote.</p>
                <AuditLogList load={loadAudit} scope="server" showCommunity />
              </>
            )}
          </Tabs>
        )}
      </div>
    </>
  );
}
