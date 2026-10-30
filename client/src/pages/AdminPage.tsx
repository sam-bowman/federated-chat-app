import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import * as api from "../api";
import { ApiError } from "../api/client";
import AuditLogList from "../components/AuditLogList";
import ReportsQueue from "../components/ReportsQueue";
import AdminCommunities from "../components/admin/AdminCommunities";
import AdminInvites from "../components/admin/AdminInvites";
import AdminOverview from "../components/admin/AdminOverview";
import AdminUsers from "../components/admin/AdminUsers";
import { SudoProvider } from "../components/admin/SudoContext";
import { useOpenReports } from "../lib/useOpenReports";
import Tabs from "../components/Tabs";

type State = { kind: "checking" } | { kind: "hidden" } | { kind: "needs-two-factor" } | { kind: "ready" } | { kind: "error" };
type Tab = "overview" | "users" | "communities" | "invites" | "reports" | "audit";

/**
 * The admin page (#206), at /admin. It is loaded only when someone goes there (App.tsx), and it asks the server whether the person is an admin
 * before showing anything: for anyone else the server answers 404 and this shows the same "not found" as any other address that is not
 * a page, so it gives away nothing about whether there is an admin page at all. What it shows is about the server and what was done to it:
 * never a message, a direct message or an attachment.
 */
export default function AdminPage() {
  const [state, setState] = useState<State>({ kind: "checking" });
  const [tab, setTab] = useState<Tab>("overview");
  // Reports waiting for the admins: asked only once the page is open for managing (an admin without two-factor sign-in is refused the count).
  const waiting = useOpenReports(null, state.kind === "ready");

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
      <div className="panel" style={{ maxWidth: "64rem" }}>
        {state.kind === "needs-two-factor" ? (
          <>
            <h3>Turn on two-factor sign-in first</h3>
            <p className="hint">
              An admin can see and change things for everyone on this server, so the admin page only opens for an account with two-factor sign-in on.
              Turn it on in <Link to="/settings">Settings</Link>, then come back here.
            </p>
          </>
        ) : (
          <SudoProvider>
            <Tabs
              label="Administration"
              tabs={[
                { id: "overview", label: "Overview" },
                { id: "users", label: "Users" },
                { id: "communities", label: "Communities" },
                { id: "invites", label: "Invites" },
                { id: "reports", label: waiting.count ? `Reports (${waiting.count})` : "Reports" },
                { id: "audit", label: "Audit log" },
              ]}
              value={tab}
              onChange={setTab}
              minHeight="20rem"
            >
              {tab === "overview" && <AdminOverview />}
              {tab === "users" && <AdminUsers />}
              {tab === "communities" && <AdminCommunities />}
              {tab === "invites" && <AdminInvites />}
              {tab === "reports" && (
                <>
                  <p className="hint">
                    Every report that reaches this server: messages in a community (also seen by its moderators), and direct messages, people and
                    communities, which only admins see. Closing a report records what was done; suspending or deleting is done on the Users and
                    Communities tabs. A report about you is not shown to you.
                  </p>
                  <ReportsQueue communityId={null} onOpenChange={waiting.set} />
                </>
              )}
              {tab === "audit" && (
                <>
                  <p className="hint">Everything that was done: what moderators did in every community, and what operators did. It holds who and what, never what anyone wrote.</p>
                  <AuditLogList load={loadAudit} scope="server" showCommunity />
                </>
              )}
            </Tabs>
          </SudoProvider>
        )}
      </div>
    </>
  );
}
